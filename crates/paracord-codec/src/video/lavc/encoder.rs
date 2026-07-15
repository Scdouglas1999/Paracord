//! In-process hardware video encoder ([`LavcEncoder`]).
//!
//! One [`LavcEncoder`] owns a fixed pipeline: a libavfilter graph that uploads
//! (and, if needed, scales/format-converts) each input frame on the GPU, wired
//! into a hardware libavcodec encoder. Both are chosen once at construction —
//! see [`super`] for the no-runtime-switching philosophy.

use super::{
    av_error_text, av_input_format_name, av_input_pix_fmt, cstr, require_encodable, LavcBackend,
    AVERROR_EAGAIN, BACKEND_ORDER,
};
use crate::video::encoder::VideoEncoder;
use crate::video::{ColorSpace, EncodedFrame, EncoderConfig, PixelFormat, VideoCodec, VideoError};
use ffmpeg_sys_next as ff;
use std::collections::HashMap;
use std::ffi::c_int;
use std::ptr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Minimum wall-clock gap between two live bitrate rebuilds. A congestion loop
/// can fire far faster than this; rebuilding the whole GPU pipeline every tick
/// would thrash, so retargets inside the window are ignored.
const BITRATE_REBUILD_MIN_INTERVAL: Duration = Duration::from_secs(2);

/// A hardware video encoder built on in-process libavcodec.
pub struct LavcEncoder {
    config: EncoderConfig,
    input_width: u32,
    input_height: u32,
    codec: VideoCodec,
    backend: LavcBackend,
    backend_name: &'static str,
    pipe: EncodePipeline,
    frames_submitted: u64,
    /// When the pipeline was last rebuilt for a live bitrate change, used to
    /// throttle [`set_bitrate`](VideoEncoder::set_bitrate).
    last_bitrate_rebuild: Option<Instant>,
    /// Force an IDR on the next encoded frame (set after a rebuild so viewers
    /// re-prime against the new-rate stream immediately).
    pending_force_idr: bool,
}

// Safety: every raw pointer inside `EncodePipeline` is created, used, and freed
// only through `&mut self`. Nothing is shared, mirroring `Vp9Encoder`.
unsafe impl Send for LavcEncoder {}

impl LavcEncoder {
    /// Create an encoder whose input frames are `config.width`×`config.height`
    /// (input dims equal output dims).
    pub fn new(codec: VideoCodec, config: EncoderConfig) -> Result<Self, VideoError> {
        let (w, h) = (config.width, config.height);
        Self::new_with_input(codec, config, w, h)
    }

    /// Create an encoder that accepts `input_width`×`input_height` frames in
    /// `config.pixel_format` and produces `config.width`×`config.height`
    /// output. When the dims differ the filter graph scales on the GPU.
    ///
    /// The backend is selected here and fixed for the encoder's life: each
    /// candidate (NVENC → VAAPI → QSV) is validated by opening a throwaway
    /// pipeline and encoding one black frame; only a backend that produces a
    /// real packet is chosen, then a fresh pipeline is built for the stream.
    pub fn new_with_input(
        codec: VideoCodec,
        config: EncoderConfig,
        input_width: u32,
        input_height: u32,
    ) -> Result<Self, VideoError> {
        require_encodable(codec)?;
        config.validate()?;
        if !matches!(
            config.pixel_format,
            PixelFormat::I420 | PixelFormat::Rgba | PixelFormat::Bgra
        ) {
            return Err(VideoError::UnsupportedPixelFormat(config.pixel_format));
        }
        if input_width == 0 || input_height == 0 {
            return Err(VideoError::InvalidDimensions {
                width: input_width,
                height: input_height,
            });
        }

        let mut errors = Vec::new();
        for backend in BACKEND_ORDER {
            if backend.encoder_name(codec).is_none() {
                continue;
            }
            // Probe-time selection: a throwaway encode of one black frame. This
            // is what makes selection honest — a backend whose context opens
            // but cannot emit a packet (missing runtime driver, unsupported
            // level) is skipped instead of failing later mid-stream.
            if let Err(err) = encode_probe_frame(codec, backend, config.width, config.height) {
                errors.push(format!("{}: {err}", backend.display_name(codec)));
                continue;
            }
            // The probe passed; build the real, stream-lifetime pipeline.
            match EncodePipeline::build(codec, backend, &config, input_width, input_height) {
                Ok(pipe) => {
                    return Ok(Self {
                        config,
                        input_width,
                        input_height,
                        codec,
                        backend,
                        backend_name: backend.display_name(codec),
                        pipe,
                        frames_submitted: 0,
                        last_bitrate_rebuild: None,
                        pending_force_idr: false,
                    });
                }
                Err(err) => errors.push(format!("{}: {err}", backend.display_name(codec))),
            }
        }

        Err(VideoError::CodecUnavailable(format!(
            "no working lavc hardware encoder for {codec:?} ({}x{}): {}",
            config.width,
            config.height,
            if errors.is_empty() {
                "no backend attempted".to_string()
            } else {
                errors.join("; ")
            }
        )))
    }

    /// The backend selected at construction.
    pub fn backend(&self) -> LavcBackend {
        self.backend
    }
}

impl VideoEncoder for LavcEncoder {
    fn encode(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        let expected = self
            .config
            .pixel_format
            .frame_size(self.input_width, self.input_height);
        if data.len() != expected {
            return Err(VideoError::FrameSizeMismatch {
                expected,
                actual: data.len(),
            });
        }
        self.frames_submitted = self.frames_submitted.saturating_add(1);
        // A rebuild for a live bitrate change requests one IDR so viewers
        // re-prime against the new-rate stream on the very next frame.
        let force_keyframe = force_keyframe || std::mem::take(&mut self.pending_force_idr);
        self.pipe
            .encode_frame(pts, data, force_keyframe, self.codec)
    }

    fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        self.pipe.flush(self.codec)
    }

    fn config(&self) -> &EncoderConfig {
        &self.config
    }

    fn codec(&self) -> VideoCodec {
        self.codec
    }

    fn backend_name(&self) -> &'static str {
        self.backend_name
    }

    fn is_hardware_accelerated(&self) -> bool {
        true
    }

    fn input_dimensions(&self) -> (u32, u32) {
        (self.input_width, self.input_height)
    }

    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<bool, VideoError> {
        // NVENC/VAAPI/QSV fix the rate when the codec context opens and expose
        // no live rate-control reconfigure, so the only honest way to retarget
        // is to rebuild the pipeline at the new rate. The rebuild is fully
        // synchronous and in-process (no subprocess to restart — the hazard the
        // old trait prohibition guarded is gone), so it is the documented lavc
        // contract. We self-throttle: ignore sub-25% deltas and rebuilds inside
        // the minimum interval so a chatty congestion loop cannot thrash.
        let new_kbps = bitrate_kbps.max(1);
        let current = self.config.bitrate_kbps.max(1);
        let delta = new_kbps.abs_diff(current);
        // <25% change: not worth a rebuild.
        if (delta as u64) * 4 < current as u64 {
            return Ok(false);
        }
        if let Some(last) = self.last_bitrate_rebuild {
            if last.elapsed() < BITRATE_REBUILD_MIN_INTERVAL {
                return Ok(false);
            }
        }

        let mut new_config = self.config.clone();
        new_config.bitrate_kbps = new_kbps;
        // Same backend, no re-probe: build directly. On failure keep the
        // existing pipeline (and rate) rather than tearing the stream down.
        let pipe = EncodePipeline::build(
            self.codec,
            self.backend,
            &new_config,
            self.input_width,
            self.input_height,
        )?;
        self.pipe = pipe;
        self.config = new_config;
        self.last_bitrate_rebuild = Some(Instant::now());
        self.pending_force_idr = true;
        Ok(true)
    }
}

// ── Encode pipeline ──────────────────────────────────────────────────

/// The libavcodec/libavfilter objects backing one encoder. All pointers are
/// owned; [`Drop`] frees them in reverse construction order.
struct EncodePipeline {
    hw_device_ctx: *mut ff::AVBufferRef,
    enc_ctx: *mut ff::AVCodecContext,
    filter_graph: *mut ff::AVFilterGraph,
    buffersrc_ctx: *mut ff::AVFilterContext,
    buffersink_ctx: *mut ff::AVFilterContext,
    /// Reusable software input wrapper — points at the caller's buffer each
    /// frame (no copy); the filter graph makes its own reference on push.
    src_frame: *mut ff::AVFrame,
    /// Reusable filter output (a hardware frame) fed to the encoder.
    filt_frame: *mut ff::AVFrame,
    packet: *mut ff::AVPacket,
    input_fmt: ff::AVPixelFormat,
    input_width: u32,
    input_height: u32,
    out_width: u32,
    out_height: u32,
    /// The colorspace this pipeline's active filter chain actually produces
    /// (contract C1). Set when the filter graph is configured — every current
    /// chain forces or honors BT.709, but this records what was really selected
    /// so [`EncodedFrame::colorspace`] never lies.
    out_colorspace: ColorSpace,
}

impl EncodePipeline {
    fn empty(
        input_fmt: ff::AVPixelFormat,
        input_width: u32,
        input_height: u32,
        out_width: u32,
        out_height: u32,
    ) -> Self {
        Self {
            hw_device_ctx: ptr::null_mut(),
            enc_ctx: ptr::null_mut(),
            filter_graph: ptr::null_mut(),
            buffersrc_ctx: ptr::null_mut(),
            buffersink_ctx: ptr::null_mut(),
            src_frame: ptr::null_mut(),
            filt_frame: ptr::null_mut(),
            packet: ptr::null_mut(),
            input_fmt,
            input_width,
            input_height,
            out_width,
            out_height,
            out_colorspace: ColorSpace::Bt709,
        }
    }

    /// Build the full GPU pipeline for one backend. Any failure returns an
    /// `Err`, dropping the partially-built pipeline so every allocation made so
    /// far is freed by [`Drop`].
    fn build(
        codec: VideoCodec,
        backend: LavcBackend,
        config: &EncoderConfig,
        input_width: u32,
        input_height: u32,
    ) -> Result<Self, VideoError> {
        let encoder_name = backend
            .encoder_name(codec)
            .ok_or_else(|| VideoError::CodecUnavailable(format!("{codec:?} has no {backend:?}")))?;
        let input_fmt = av_input_pix_fmt(config.pixel_format);
        let out_w = config.width;
        let out_h = config.height;

        let mut pipe = Self::empty(input_fmt, input_width, input_height, out_w, out_h);

        unsafe {
            // 1. Hardware device.
            pipe.hw_device_ctx = create_hw_device(backend)?;

            // 2. Find the encoder before building the graph so a missing
            // encoder fails cheaply.
            let encoder = ff::avcodec_find_encoder_by_name(cstr(encoder_name).as_ptr());
            if encoder.is_null() {
                return Err(VideoError::CodecUnavailable(format!(
                    "libavcodec encoder '{encoder_name}' not present in this ffmpeg build"
                )));
            }

            // 3. Filter graph: sw input → GPU upload/scale → hw frames. Returns
            // the colorspace the selected chain actually produces.
            pipe.out_colorspace =
                pipe.build_filter_graph(backend, config, input_width, input_height)?;

            // 4. The encoder consumes the buffersink's hardware frames, so its
            // hw_frames_ctx must come from the configured graph.
            let hw_frames = ff::av_buffersink_get_hw_frames_ctx(pipe.buffersink_ctx);
            if hw_frames.is_null() {
                return Err(VideoError::EncoderInit(format!(
                    "{}: filter graph produced no hardware frames context",
                    backend.display_name(codec)
                )));
            }

            // 5. Encoder context.
            pipe.enc_ctx = ff::avcodec_alloc_context3(encoder);
            if pipe.enc_ctx.is_null() {
                return Err(VideoError::EncoderInit(
                    "avcodec_alloc_context3 failed".into(),
                ));
            }
            configure_encoder_context(pipe.enc_ctx, backend, codec, config, hw_frames);

            let ret = ff::avcodec_open2(pipe.enc_ctx, encoder, ptr::null_mut());
            if ret < 0 {
                return Err(VideoError::EncoderInit(format!(
                    "{}: avcodec_open2 failed: {}",
                    backend.display_name(codec),
                    av_error_text(ret)
                )));
            }

            // 6. Reusable frames/packet.
            pipe.src_frame = ff::av_frame_alloc();
            pipe.filt_frame = ff::av_frame_alloc();
            pipe.packet = ff::av_packet_alloc();
            if pipe.src_frame.is_null() || pipe.filt_frame.is_null() || pipe.packet.is_null() {
                return Err(VideoError::EncoderInit(
                    "av_frame/packet_alloc failed".into(),
                ));
            }
        }

        Ok(pipe)
    }

    /// Build and configure the libavfilter graph, returning the colorspace the
    /// selected chain actually produces (contract C1).
    ///
    /// Each candidate chain is a `buffer` source delivering the caller's
    /// software pixel format, a GPU upload, optional GPU scale/convert, and a
    /// `buffersink`. On NVENC the input format is *preserved* through the upload
    /// and scale (`scale_cuda` cannot convert packed RGB on this build); the
    /// encoder does the RGB→NV12 conversion on the GPU honoring the context's
    /// BT.709 color settings, so there is zero CPU pixel conversion.
    ///
    /// On VAAPI two chains are tried in order (K9): first a GPU RGB→NV12
    /// conversion (`hwupload,scale_vaapi=...:format=nv12:out_color_matrix=bt709`)
    /// which Mesa/iHD VPP can do on-device; if `avfilter_graph_config` rejects
    /// it, a CPU-convert chain that forces BT.709 in libswscale. The choice is
    /// deterministic per construction (capability probing, not silent
    /// mid-stream degradation) and logged loudly.
    unsafe fn build_filter_graph(
        &mut self,
        backend: LavcBackend,
        config: &EncoderConfig,
        input_width: u32,
        input_height: u32,
    ) -> Result<ColorSpace, VideoError> {
        let candidates = filter_chain_candidates(backend, config, input_width, input_height);
        let mut last_err = None;
        let total = candidates.len();
        for (idx, candidate) in candidates.into_iter().enumerate() {
            match self.configure_graph_with_chain(
                config,
                input_width,
                input_height,
                &candidate.desc,
            ) {
                Ok(()) => {
                    if idx == 0 {
                        tracing::info!(
                            backend = ?backend,
                            chain = %candidate.desc,
                            colorspace = ?candidate.colorspace,
                            "lavc: filter chain active"
                        );
                    } else {
                        tracing::warn!(
                            backend = ?backend,
                            chain = %candidate.desc,
                            colorspace = ?candidate.colorspace,
                            "lavc: primary GPU-convert filter chain unavailable; using CPU-convert fallback"
                        );
                    }
                    return Ok(candidate.colorspace);
                }
                Err(err) => {
                    if idx + 1 < total {
                        tracing::debug!(
                            backend = ?backend,
                            chain = %candidate.desc,
                            error = %err,
                            "lavc: filter chain candidate rejected; trying next"
                        );
                    }
                    last_err = Some(err);
                    self.free_filter_graph();
                }
            }
        }
        Err(last_err
            .unwrap_or_else(|| VideoError::EncoderInit("no filter chain candidates".into())))
    }

    /// Allocate and configure the graph for one concrete chain string. On any
    /// failure the caller frees the partial graph via [`free_filter_graph`] and
    /// may retry with the next candidate.
    unsafe fn configure_graph_with_chain(
        &mut self,
        config: &EncoderConfig,
        input_width: u32,
        input_height: u32,
        filter_desc: &str,
    ) -> Result<(), VideoError> {
        self.filter_graph = ff::avfilter_graph_alloc();
        if self.filter_graph.is_null() {
            return Err(VideoError::EncoderInit(
                "avfilter_graph_alloc failed".into(),
            ));
        }

        // Buffer source: describes the software frames we will push.
        let buffer = ff::avfilter_get_by_name(cstr("buffer").as_ptr());
        let buffersink = ff::avfilter_get_by_name(cstr("buffersink").as_ptr());
        if buffer.is_null() || buffersink.is_null() {
            return Err(VideoError::EncoderInit(
                "libavfilter 'buffer'/'buffersink' unavailable".into(),
            ));
        }

        let src_args = format!(
            "video_size={}x{}:pix_fmt={}:time_base=1/{}:pixel_aspect=1/1",
            input_width,
            input_height,
            self.input_fmt as c_int,
            config.fps.max(1),
        );
        let ret = ff::avfilter_graph_create_filter(
            &mut self.buffersrc_ctx,
            buffer,
            cstr("in").as_ptr(),
            cstr(&src_args).as_ptr(),
            ptr::null_mut(),
            self.filter_graph,
        );
        if ret < 0 {
            return Err(VideoError::EncoderInit(format!(
                "create buffer source failed: {}",
                av_error_text(ret)
            )));
        }
        let ret = ff::avfilter_graph_create_filter(
            &mut self.buffersink_ctx,
            buffersink,
            cstr("out").as_ptr(),
            ptr::null(),
            ptr::null_mut(),
            self.filter_graph,
        );
        if ret < 0 {
            return Err(VideoError::EncoderInit(format!(
                "create buffersink failed: {}",
                av_error_text(ret)
            )));
        }

        // Parse the middle of the chain (upload + optional scale) between the
        // labelled endpoints, following the canonical filtering_video.c wiring
        // where the source is named "in" and the sink "out".
        let outputs = ff::avfilter_inout_alloc();
        let inputs = ff::avfilter_inout_alloc();
        if outputs.is_null() || inputs.is_null() {
            if !outputs.is_null() {
                ff::avfilter_inout_free(&mut { outputs });
            }
            if !inputs.is_null() {
                ff::avfilter_inout_free(&mut { inputs });
            }
            return Err(VideoError::EncoderInit(
                "avfilter_inout_alloc failed".into(),
            ));
        }
        (*outputs).name = ff::av_strdup(cstr("in").as_ptr());
        (*outputs).filter_ctx = self.buffersrc_ctx;
        (*outputs).pad_idx = 0;
        (*outputs).next = ptr::null_mut();
        (*inputs).name = ff::av_strdup(cstr("out").as_ptr());
        (*inputs).filter_ctx = self.buffersink_ctx;
        (*inputs).pad_idx = 0;
        (*inputs).next = ptr::null_mut();

        let mut inputs = inputs;
        let mut outputs = outputs;
        let ret = ff::avfilter_graph_parse_ptr(
            self.filter_graph,
            cstr(filter_desc).as_ptr(),
            &mut inputs,
            &mut outputs,
            ptr::null_mut(),
        );
        ff::avfilter_inout_free(&mut inputs);
        ff::avfilter_inout_free(&mut outputs);
        if ret < 0 {
            return Err(VideoError::EncoderInit(format!(
                "avfilter_graph_parse_ptr('{filter_desc}') failed: {}",
                av_error_text(ret)
            )));
        }

        // The GPU filters (hwupload*, scale_*) need the hardware device. ffmpeg
        // assigns this per filter; setting it on every filter in the graph is
        // the standard in-process idiom — filters that don't need a device just
        // hold an unused ref, freed with the graph.
        for i in 0..(*self.filter_graph).nb_filters {
            let filt = *(*self.filter_graph).filters.add(i as usize);
            if (*filt).hw_device_ctx.is_null() {
                (*filt).hw_device_ctx = ff::av_buffer_ref(self.hw_device_ctx);
            }
        }

        let ret = ff::avfilter_graph_config(self.filter_graph, ptr::null_mut());
        if ret < 0 {
            return Err(VideoError::EncoderInit(format!(
                "avfilter_graph_config failed: {}",
                av_error_text(ret)
            )));
        }
        Ok(())
    }

    /// Free a partially-built filter graph so the next candidate chain starts
    /// clean. `avfilter_graph_free` frees every filter context the graph owns
    /// (buffersrc/buffersink included) and nulls the graph pointer.
    unsafe fn free_filter_graph(&mut self) {
        if !self.filter_graph.is_null() {
            ff::avfilter_graph_free(&mut self.filter_graph);
        }
        self.buffersrc_ctx = ptr::null_mut();
        self.buffersink_ctx = ptr::null_mut();
    }

    /// Encode one frame. Wraps the caller's buffer (no copy), pushes it through
    /// the GPU filter graph, stamps the keyframe request onto the frame the
    /// encoder actually receives, and drains packets.
    fn encode_frame(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
        codec: VideoCodec,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        unsafe {
            let src = self.src_frame;
            (*src).format = self.input_fmt as c_int;
            (*src).width = self.input_width as c_int;
            (*src).height = self.input_height as c_int;
            (*src).pts = pts;
            // Wrap the caller's bytes in place. `av_buffersrc_add_frame_flags`
            // with KEEP_REF makes the graph's own copy, so the caller's buffer
            // need only stay valid for this call.
            let ret = ff::av_image_fill_arrays(
                (*src).data.as_mut_ptr(),
                (*src).linesize.as_mut_ptr(),
                data.as_ptr(),
                self.input_fmt,
                self.input_width as c_int,
                self.input_height as c_int,
                1,
            );
            if ret < 0 {
                return Err(VideoError::EncodeFailed(format!(
                    "av_image_fill_arrays failed: {}",
                    av_error_text(ret)
                )));
            }
            apply_keyframe_request(src, force_keyframe);

            let ret = ff::av_buffersrc_add_frame_flags(
                self.buffersrc_ctx,
                src,
                ff::AV_BUFFERSRC_FLAG_KEEP_REF as c_int,
            );
            if ret < 0 {
                return Err(VideoError::EncodeFailed(format!(
                    "av_buffersrc_add_frame failed: {}",
                    av_error_text(ret)
                )));
            }

            let mut frames = Vec::new();
            loop {
                let ret = ff::av_buffersink_get_frame(self.buffersink_ctx, self.filt_frame);
                if ret == AVERROR_EAGAIN || ret == ff::AVERROR_EOF {
                    break;
                }
                if ret < 0 {
                    return Err(VideoError::EncodeFailed(format!(
                        "av_buffersink_get_frame failed: {}",
                        av_error_text(ret)
                    )));
                }
                // The keyframe request must ride the frame the encoder sees.
                // Filters generally propagate pict_type, but restamp to be sure.
                apply_keyframe_request(self.filt_frame, force_keyframe);
                (*self.filt_frame).pts = pts;
                let send = self.send_frame_and_drain(self.filt_frame, codec, &mut frames);
                ff::av_frame_unref(self.filt_frame);
                send?;
            }
            Ok(frames)
        }
    }

    /// Send one frame (or null to flush) to the encoder and drain all ready
    /// packets into `out`.
    unsafe fn send_frame_and_drain(
        &mut self,
        frame: *mut ff::AVFrame,
        codec: VideoCodec,
        out: &mut Vec<EncodedFrame>,
    ) -> Result<(), VideoError> {
        let ret = ff::avcodec_send_frame(self.enc_ctx, frame);
        if ret < 0 && ret != ff::AVERROR_EOF {
            return Err(VideoError::EncodeFailed(format!(
                "avcodec_send_frame failed: {}",
                av_error_text(ret)
            )));
        }
        loop {
            let ret = ff::avcodec_receive_packet(self.enc_ctx, self.packet);
            if ret == AVERROR_EAGAIN || ret == ff::AVERROR_EOF {
                break;
            }
            if ret < 0 {
                return Err(VideoError::EncodeFailed(format!(
                    "avcodec_receive_packet failed: {}",
                    av_error_text(ret)
                )));
            }
            let pkt = self.packet;
            let bytes = std::slice::from_raw_parts((*pkt).data, (*pkt).size as usize).to_vec();
            let is_keyframe = ((*pkt).flags & ff::AV_PKT_FLAG_KEY) != 0;
            let pts = (*pkt).pts;
            out.push(EncodedFrame {
                data: bytes,
                codec,
                pts,
                is_keyframe,
                layer: None,
                width: self.out_width,
                height: self.out_height,
                colorspace: self.out_colorspace,
            });
            ff::av_packet_unref(pkt);
        }
        Ok(())
    }

    fn flush(&mut self, codec: VideoCodec) -> Result<Vec<EncodedFrame>, VideoError> {
        let mut frames = Vec::new();
        unsafe {
            // Flush the filter graph, then the encoder. With max_b_frames=0 and
            // low delay there is normally nothing buffered, but do it correctly.
            let _ = ff::av_buffersrc_add_frame_flags(self.buffersrc_ctx, ptr::null_mut(), 0);
            loop {
                let ret = ff::av_buffersink_get_frame(self.buffersink_ctx, self.filt_frame);
                if ret == AVERROR_EAGAIN || ret == ff::AVERROR_EOF {
                    break;
                }
                if ret < 0 {
                    return Err(VideoError::EncodeFailed(format!(
                        "flush: av_buffersink_get_frame failed: {}",
                        av_error_text(ret)
                    )));
                }
                let send = self.send_frame_and_drain(self.filt_frame, codec, &mut frames);
                ff::av_frame_unref(self.filt_frame);
                send?;
            }
            self.send_frame_and_drain(ptr::null_mut(), codec, &mut frames)?;
        }
        Ok(frames)
    }
}

impl Drop for EncodePipeline {
    fn drop(&mut self) {
        unsafe {
            if !self.packet.is_null() {
                ff::av_packet_free(&mut self.packet);
            }
            if !self.filt_frame.is_null() {
                ff::av_frame_free(&mut self.filt_frame);
            }
            if !self.src_frame.is_null() {
                ff::av_frame_free(&mut self.src_frame);
            }
            if !self.enc_ctx.is_null() {
                ff::avcodec_free_context(&mut self.enc_ctx);
            }
            if !self.filter_graph.is_null() {
                // Frees the graph and every filter context it owns
                // (buffersrc/buffersink included).
                ff::avfilter_graph_free(&mut self.filter_graph);
            }
            if !self.hw_device_ctx.is_null() {
                ff::av_buffer_unref(&mut self.hw_device_ctx);
            }
        }
    }
}

// ── Free functions ───────────────────────────────────────────────────

/// Stamp (or clear) a per-frame keyframe request. Setting `pict_type = I` plus
/// `AV_FRAME_FLAG_KEY` is what the subprocess backends could never do — it
/// forces an intra frame for exactly this timestamp. NVENC additionally needs
/// its `forced-idr` private option (set at open) so the intra frame is a true
/// IDR, not merely an I-frame.
///
/// Shared with the dma-buf import pipeline ([`super::dmabuf`]) so a keyframe
/// request rides the imported hardware frame identically to the SHM path.
pub(super) unsafe fn apply_keyframe_request(frame: *mut ff::AVFrame, force_keyframe: bool) {
    if force_keyframe {
        (*frame).pict_type = ff::AVPictureType::AV_PICTURE_TYPE_I;
        (*frame).flags |= ff::AV_FRAME_FLAG_KEY;
    } else {
        // Let the encoder decide (honor its GOP); never suppress its own
        // periodic keyframes.
        (*frame).pict_type = ff::AVPictureType::AV_PICTURE_TYPE_NONE;
        (*frame).flags &= !ff::AV_FRAME_FLAG_KEY;
    }
}

/// Create the backend's hardware device context.
unsafe fn create_hw_device(backend: LavcBackend) -> Result<*mut ff::AVBufferRef, VideoError> {
    let mut device = ptr::null_mut();
    // VAAPI can target a specific DRM render node; honor the same override the
    // subprocess backend used. NULL lets ffmpeg auto-select.
    let device_str = if backend == LavcBackend::Vaapi {
        std::env::var("PARACORD_VAAPI_DEVICE")
            .ok()
            .map(|p| cstr(&p))
    } else {
        None
    };
    let device_ptr = device_str.as_ref().map_or(ptr::null(), |c| c.as_ptr());
    let ret = ff::av_hwdevice_ctx_create(
        &mut device,
        backend.hwdevice_type(),
        device_ptr,
        ptr::null_mut(),
        0,
    );
    if ret < 0 {
        return Err(VideoError::EncoderInit(format!(
            "{backend:?} hwdevice create failed: {}",
            av_error_text(ret)
        )));
    }
    Ok(device)
}

/// One candidate libavfilter chain (between buffer source and sink) plus the
/// colorspace it produces.
struct FilterCandidate {
    desc: String,
    colorspace: ColorSpace,
}

/// The ordered libavfilter chain candidates for a backend. The first that
/// `avfilter_graph_config` accepts wins; extra candidates exist only for VAAPI,
/// where GPU RGB→NV12 conversion is preferred but not guaranteed by every
/// driver (K9). Every chain forces or honors BT.709 limited range (C1).
fn filter_chain_candidates(
    backend: LavcBackend,
    config: &EncoderConfig,
    input_width: u32,
    input_height: u32,
) -> Vec<FilterCandidate> {
    let (out_w, out_h) = (config.width, config.height);
    let needs_scale = (input_width, input_height) != (out_w, out_h);
    // Force BT.709 limited range in a CPU libswscale conversion. `scale` with
    // an explicit output color matrix + range performs the RGB→YUV conversion
    // under 709, then `format=nv12` lands in the VAAPI/QSV upload format.
    const CPU_709_NV12: &str = "scale=out_color_matrix=bt709:out_range=tv,format=nv12";
    match backend {
        LavcBackend::Nvenc => {
            // Preserve the packed input through upload/scale; NVENC does the final
            // pixel conversion to NV12 on the GPU. scale_cuda has no color-matrix
            // control on this build (verified: `ffmpeg -h filter=scale_cuda`
            // exposes only w/h/format/interp), so the matrix is whatever NVENC's
            // fixed-function input CSC uses — it is NOT forceable from the chain.
            //
            // MEASURED (examples/nvenc_colorspace_probe.rs, 2026-07-06, RTX 4080,
            // driver 610.43.02, ffmpeg n8.1.2): NVENC's internal packed-RGB→NV12
            // conversion is BT.601 limited (red/green/blue patch means land on
            // BT.601 within ±1, BT.709 is off by 18-27 on luma). So the honest
            // colorspace of the *packed-RGB* path is 601 (contract C1 —
            // signaled==actual). When the caller pre-converts to I420 on the CPU
            // (bgra_to_i420 uses BT.709), NVENC does no CSC and the frames stay
            // 709.
            let packed_rgb = matches!(config.pixel_format, PixelFormat::Bgra | PixelFormat::Rgba);
            let colorspace = if packed_rgb {
                ColorSpace::Bt601
            } else {
                ColorSpace::Bt709
            };
            let fmt = av_input_format_name(config.pixel_format);
            let desc = if needs_scale {
                format!("hwupload_cuda,scale_cuda=w={out_w}:h={out_h}:format={fmt}")
            } else {
                "hwupload_cuda".to_string()
            };
            vec![FilterCandidate { desc, colorspace }]
        }
        LavcBackend::Vaapi => {
            // Primary: convert RGB→NV12 on the GPU. scale_vaapi accepts an
            // explicit output matrix/range, so the conversion is a true 709 and
            // there is zero CPU pixel work. Some drivers cannot upload packed
            // RGB surfaces / convert in VPP; if graph config rejects this the
            // caller falls back to the CPU chain below.
            let gpu = format!(
                "hwupload,scale_vaapi=w={out_w}:h={out_h}:format=nv12:out_color_matrix=bt709:out_range=limited"
            );
            // Fallback: force 709 on the CPU, then upload (and GPU-scale if the
            // sizes differ).
            let cpu = if needs_scale {
                format!("{CPU_709_NV12},hwupload,scale_vaapi=w={out_w}:h={out_h}:format=nv12")
            } else {
                format!("{CPU_709_NV12},hwupload")
            };
            vec![
                FilterCandidate {
                    desc: gpu,
                    colorspace: ColorSpace::Bt709,
                },
                FilterCandidate {
                    desc: cpu,
                    colorspace: ColorSpace::Bt709,
                },
            ]
        }
        LavcBackend::Qsv => {
            // QSV uploads NV12 system frames; force 709 on the CPU convert, then
            // GPU-scale via vpp_qsv if needed.
            let desc = if needs_scale {
                format!("{CPU_709_NV12},hwupload,vpp_qsv=w={out_w}:h={out_h}")
            } else {
                format!("{CPU_709_NV12},hwupload")
            };
            vec![FilterCandidate {
                desc,
                colorspace: ColorSpace::Bt709,
            }]
        }
    }
}

/// Apply rate control and low-latency tuning to the encoder context. Mirrors
/// the proven subprocess flags: CBR-ish VBR with `maxrate=bitrate`,
/// `bufsize=2×bitrate`, no B-frames, no lookahead/delay.
///
/// Shared with the dma-buf import pipeline ([`super::dmabuf`]) so the imported
/// VAAPI path gets byte-identical rate control and BT.709 signalling (C1) as
/// the SHM VAAPI path — the two differ only in how frames reach the encoder.
pub(super) unsafe fn configure_encoder_context(
    ctx: *mut ff::AVCodecContext,
    backend: LavcBackend,
    codec: VideoCodec,
    config: &EncoderConfig,
    hw_frames: *mut ff::AVBufferRef,
) {
    let fps = config.fps.max(1);
    let bitrate_bps = (config.bitrate_kbps.max(1) as i64) * 1000;
    // VAAPI runs an explicit VBR (see below); give it 1.5× headroom over the
    // target so the rate controller can spend on complex frames. Other backends
    // keep a CBR-ish cap at the target.
    let max_rate_bps = match backend {
        LavcBackend::Vaapi => bitrate_bps.saturating_mul(3) / 2,
        _ => bitrate_bps,
    };

    (*ctx).width = config.width as c_int;
    (*ctx).height = config.height as c_int;
    (*ctx).time_base = ff::AVRational {
        num: 1,
        den: fps as c_int,
    };
    (*ctx).framerate = ff::AVRational {
        num: fps as c_int,
        den: 1,
    };
    (*ctx).pix_fmt = backend.hw_pix_fmt();
    (*ctx).bit_rate = bitrate_bps;
    (*ctx).rc_max_rate = max_rate_bps;
    // bufsize in bits, capped so the i32 field can't overflow at high bitrates.
    (*ctx).rc_buffer_size = max_rate_bps.saturating_mul(2).min(i32::MAX as i64) as c_int;

    // Signal the YUV matrix the bitstream is ACTUALLY in (contract C1 —
    // signaled must equal actual), limited range throughout.
    //
    // VAAPI/QSV: the filter chain forces BT.709 (out_color_matrix=bt709 on GPU,
    // or libswscale on the CPU floor), so the matrix tag is BT.709.
    //
    // NVENC with packed-RGB input: NVENC's fixed-function input CSC does the
    // RGB→NV12 conversion, and it is NOT BT.709. MEASURED on this machine
    // (examples/nvenc_colorspace_probe.rs, 2026-07-06, RTX 4080, driver
    // 610.43.02, ffmpeg n8.1.2): the internal matrix is BT.601 limited, and
    // scale_cuda exposes no matrix control to force 709. Honest-match rule:
    // signal BT.601 for that path so decoders invert with the same matrix NVENC
    // used. (Primaries/transfer still describe the sRGB source gamut, which the
    // CSC does not change, so they stay BT.709/sRGB-adjacent.) NVENC with
    // pre-converted I420 input does no CSC — those frames are the caller's 709.
    let nvenc_packed_rgb = backend == LavcBackend::Nvenc
        && matches!(config.pixel_format, PixelFormat::Bgra | PixelFormat::Rgba);
    (*ctx).colorspace = if nvenc_packed_rgb {
        ff::AVColorSpace::AVCOL_SPC_SMPTE170M
    } else {
        ff::AVColorSpace::AVCOL_SPC_BT709
    };
    (*ctx).color_primaries = ff::AVColorPrimaries::AVCOL_PRI_BT709;
    (*ctx).color_trc = ff::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
    (*ctx).color_range = ff::AVColorRange::AVCOL_RANGE_MPEG;
    // Honor the requested keyframe interval as given. `0` means "no fixed
    // cadence": we deliver keyframes on demand via force_keyframe (the whole
    // point of this engine), with a 10-second safety keyframe so a viewer that
    // missed a request still recovers. We deliberately do NOT replicate the
    // subprocess ≤1-second GOP hack.
    (*ctx).gop_size = if config.keyframe_interval > 0 {
        config.keyframe_interval as c_int
    } else {
        (fps.saturating_mul(10)).min(i32::MAX as u32) as c_int
    };
    (*ctx).max_b_frames = 0;
    (*ctx).flags |= ff::AV_CODEC_FLAG_LOW_DELAY as c_int;
    // Input frames are the graph's hardware frames.
    (*ctx).hw_frames_ctx = ff::av_buffer_ref(hw_frames);

    let priv_data = (*ctx).priv_data;
    if priv_data.is_null() {
        return;
    }
    // Private options are best-effort tuning: an option missing on this ffmpeg
    // build must not fail construction (the encode probe verifies the encoder
    // actually works), so we ignore individual set errors — matching the
    // `let _ = vpx_codec_control_` style in the VP9 encoder.
    let set = |name: &str, val: &str| {
        ff::av_opt_set(priv_data, cstr(name).as_ptr(), cstr(val).as_ptr(), 0);
    };
    let set_int = |name: &str, val: i64| {
        ff::av_opt_set_int(priv_data, cstr(name).as_ptr(), val, 0);
    };

    let pixels = (config.width as u64).saturating_mul(config.height as u64);
    match backend {
        LavcBackend::Nvenc => {
            // p1=fastest…p7=slowest/best. At/under 1440p60 there is enough
            // frame budget for the higher-quality p6; above it, drop to p5 so
            // the encoder still fits inside the frame interval.
            let preset = if pixels <= 2560 * 1440 && fps <= 60 {
                "p6"
            } else {
                "p5"
            };
            set("preset", preset);
            set("tune", "ull");
            set("rc", "vbr");
            set("cq", quality_cq(config));
            set_int("zerolatency", 1);
            set_int("delay", 0);
            // forced-idr makes a pict_type=I frame a real IDR (H.264/HEVC);
            // harmless/ignored where unsupported.
            set_int("forced-idr", 1);
            // Adaptive quantization redistributes bits toward detail. Enable for
            // AV1 as well as H.264 (av1_nvenc supports both AQ modes).
            set_int("spatial-aq", 1);
            set_int("temporal-aq", 1);
            set_int("aq-strength", 8);
        }
        LavcBackend::Vaapi => {
            // Explicit VBR with the 1.5× max-rate headroom set on the context.
            set("rc_mode", "VBR");
            // `quality` trades speed for compression efficiency where the driver
            // exposes it (ignored otherwise).
            set_int("quality", 4);
            // Keep the pipeline shallow for low latency.
            set_int("async_depth", 1);
            if codec == VideoCodec::H264 {
                set("profile", "high");
            }
        }
        LavcBackend::Qsv => {
            set_int("async_depth", 1);
            // `faster` buys efficiency at 1080p and below where the budget
            // allows it; larger frames stay on `veryfast`.
            let preset = if pixels <= 1920 * 1080 {
                "faster"
            } else {
                "veryfast"
            };
            set("preset", preset);
        }
    }
}

/// Constant-quality target, matching the subprocess `quality_qp` mapping.
fn quality_cq(config: &EncoderConfig) -> &'static str {
    use crate::video::VideoContentHint::*;
    match config.content_hint {
        Detail => "17",
        Film | Default => "18",
        Motion => "19",
    }
}

// ── Probe / one-shot encode ──────────────────────────────────────────

/// Build a throwaway pipeline for `(codec, backend)` at `width`×`height` with a
/// black BGRA frame, encode one forced keyframe, and return its bytes.
///
/// Used three ways: backend selection in [`LavcEncoder::new_with_input`],
/// [`super::probe_lavc_encoder`], and [`super::generate_probe_frame`]. Building
/// a separate context (rather than probing the real stream encoder) keeps the
/// stream's timestamps clean — the probe never feeds a frame into the encoder
/// the caller will use.
/// Process-wide cache of probe results keyed by `(codec, backend)`.
///
/// Whether a backend can encode a codec is a hardware property independent of
/// the exact probe resolution, so the first probe's outcome is reused for every
/// later encoder construction and capability query. Without this, a single
/// stream start opens 4–6 throwaway GPU sessions (one per backend, twice over
/// for construction + capability detection). Both success (with the real
/// bitstream bytes) and failure (with its message) are cached: the choice is
/// deterministic for the process, matching the no-runtime-switching philosophy.
type ProbeCache = Mutex<HashMap<(VideoCodec, LavcBackend), Result<Vec<u8>, String>>>;

fn probe_cache() -> &'static ProbeCache {
    static CACHE: OnceLock<ProbeCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached front end for [`encode_probe_frame_uncached`]. See [`ProbeCache`].
pub(crate) fn encode_probe_frame(
    codec: VideoCodec,
    backend: LavcBackend,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, VideoError> {
    require_encodable(codec)?;
    let key = (codec, backend);
    if let Some(cached) = probe_cache().lock().unwrap().get(&key).cloned() {
        return cached.map_err(VideoError::CodecUnavailable);
    }
    let result = encode_probe_frame_uncached(codec, backend, width, height);
    probe_cache()
        .lock()
        .unwrap()
        .insert(key, result.as_ref().map_err(|e| e.to_string()).cloned());
    result
}

fn encode_probe_frame_uncached(
    codec: VideoCodec,
    backend: LavcBackend,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, VideoError> {
    require_encodable(codec)?;
    let config = EncoderConfig {
        width,
        height,
        fps: 30,
        bitrate_kbps: 4_000,
        pixel_format: PixelFormat::Bgra,
        keyframe_interval: 30,
        content_hint: crate::video::VideoContentHint::Default,
    };
    let mut pipe = EncodePipeline::build(codec, backend, &config, width, height)?;
    // Black BGRA frame (all zero is black-with-zero-alpha, fine for a probe).
    let black = vec![0u8; PixelFormat::Bgra.frame_size(width, height)];
    let mut frames = pipe.encode_frame(0, &black, true, codec)?;
    if frames.is_empty() {
        // Low-delay encoders emit immediately, but flush to be certain we can
        // classify the backend as "produces a real packet".
        frames = pipe.flush(codec)?;
    }
    frames
        .into_iter()
        .next()
        .map(|f| f.data)
        .filter(|d| !d.is_empty())
        .ok_or_else(|| {
            VideoError::EncodeFailed(format!(
                "{} produced no packet for a probe frame",
                backend.display_name(codec)
            ))
        })
}
