//! Shared-upload hardware simulcast encoder ([`LavcSimulcastEncoder`]).
//!
//! The per-layer route built one [`super::LavcEncoder`] per simulcast layer, and
//! each owned a filter graph that uploaded the full capture frame to the GPU on
//! its own. On a 5120x1440 screen that was three 29.5 MB uploads (plus three CPU
//! copies, because `av_buffersrc_add_frame` copies a frame it does not own) per
//! frame: 24 to 33 ms of the encode thread, so 60 fps presets topped out at 30
//! to 37 fps (stream audit B2).
//!
//! Here one filter graph uploads the frame once and splits the GPU copy to a
//! scaler per layer:
//!
//! ```text
//! buffer ─ hwupload ─ split ─┬─ scale (low)    ─ buffersink 0 ─ encoder 0
//!                            ├─ scale (medium) ─ buffersink 1 ─ encoder 1
//!                            └─ (source size)  ─ buffersink 2 ─ encoder 2
//! ```
//!
//! The caller's buffer is handed to the graph by reference (no CPU copy). Each
//! layer's encoder runs on its own thread, so a frame costs the upload plus the
//! slowest layer rather than the sum of all three (the top layer of a 5120x1440
//! share is ~8 ms of NVENC on its own). Every stage is timed so a live share
//! reports where its frame budget goes.
//! The backend is chosen once, by the same probe as [`super::LavcEncoder`].

use super::encoder::{
    apply_keyframe_request, configure_encoder_context, create_hw_device, encode_probe_frame,
    retarget_nvenc_in_place,
};
use super::{
    av_error_text, av_input_format_name, av_input_pix_fmt, cstr, require_encodable, LavcBackend,
    AVERROR_EAGAIN, BACKEND_ORDER,
};
use crate::video::encoder::SharedSimulcastBackend;
use crate::video::{
    ColorSpace, EncodedFrame, EncoderConfig, PixelFormat, SimulcastLayer, VideoCodec, VideoError,
};
use ffmpeg_sys_next as ff;
use std::ffi::c_int;
use std::os::raw::c_void;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// How often [`LavcSimulcastEncoder::stage_report`] summarizes the stage times.
const STAGE_REPORT_INTERVAL: Duration = Duration::from_secs(5);

struct SharedLayer {
    layer: SimulcastLayer,
    config: EncoderConfig,
    sink: *mut ff::AVFilterContext,
    enc_ctx: *mut ff::AVCodecContext,
    /// The frame this layer's sink produced for the current input.
    frame: *mut ff::AVFrame,
}

/// Every simulcast layer encoded from one GPU upload of each input frame.
pub struct LavcSimulcastEncoder {
    codec: VideoCodec,
    backend: LavcBackend,
    backend_name: &'static str,
    pixel_format: PixelFormat,
    input_fmt: ff::AVPixelFormat,
    input_width: u32,
    input_height: u32,
    hw_device_ctx: *mut ff::AVBufferRef,
    filter_graph: *mut ff::AVFilterGraph,
    buffersrc_ctx: *mut ff::AVFilterContext,
    layers: Vec<SharedLayer>,
    /// One encode thread per layer, in layer order.
    workers: Vec<LayerWorker>,
    src_frame: *mut ff::AVFrame,
    packet: *mut ff::AVPacket,
    out_colorspace: ColorSpace,
    /// Set by the input buffer's free callback once the graph lets go of the
    /// caller's pixels. Boxed so its address is stable for the callback.
    input_released: Box<AtomicBool>,
    stats: StageStats,
}

// Safety: every raw pointer is created, used and freed only through `&mut self`.
unsafe impl Send for LavcSimulcastEncoder {}

impl LavcSimulcastEncoder {
    /// Build the shared pipeline for `layers` (lowest first), taking packed
    /// `input_width`×`input_height` frames in each layer config's pixel format
    /// (which must be the same packed format for every layer).
    pub fn new(
        codec: VideoCodec,
        input_width: u32,
        input_height: u32,
        layers: &[(SimulcastLayer, EncoderConfig)],
    ) -> Result<Self, VideoError> {
        require_encodable(codec)?;
        let Some((_, first)) = layers.first() else {
            return Err(VideoError::EncoderInit(
                "shared simulcast needs at least one layer".into(),
            ));
        };
        let pixel_format = first.pixel_format;
        if !matches!(pixel_format, PixelFormat::Bgra | PixelFormat::Rgba) {
            return Err(VideoError::UnsupportedPixelFormat(pixel_format));
        }
        for (_, config) in layers {
            config.validate()?;
            if config.pixel_format != pixel_format {
                return Err(VideoError::EncoderInit(format!(
                    "shared simulcast layers disagree on input format ({:?} vs {pixel_format:?})",
                    config.pixel_format
                )));
            }
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
            let (top_w, top_h) = layers
                .last()
                .map(|(_, c)| (c.width, c.height))
                .unwrap_or((input_width, input_height));
            if let Err(err) = encode_probe_frame(codec, backend, top_w, top_h) {
                errors.push(format!("{}: {err}", backend.display_name(codec)));
                continue;
            }
            match Self::build(
                codec,
                backend,
                pixel_format,
                input_width,
                input_height,
                layers,
            ) {
                Ok(encoder) => return Ok(encoder),
                Err(err) => errors.push(format!("{}: {err}", backend.display_name(codec))),
            }
        }
        Err(VideoError::CodecUnavailable(format!(
            "no working lavc hardware simulcast encoder for {codec:?} ({input_width}x{input_height}, {} layers): {}",
            layers.len(),
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

    fn build(
        codec: VideoCodec,
        backend: LavcBackend,
        pixel_format: PixelFormat,
        input_width: u32,
        input_height: u32,
        layer_configs: &[(SimulcastLayer, EncoderConfig)],
    ) -> Result<Self, VideoError> {
        let encoder_name = backend
            .encoder_name(codec)
            .ok_or_else(|| VideoError::CodecUnavailable(format!("{codec:?} has no {backend:?}")))?;
        let mut this = Self {
            codec,
            backend,
            backend_name: backend.display_name(codec),
            pixel_format,
            input_fmt: av_input_pix_fmt(pixel_format),
            input_width,
            input_height,
            hw_device_ctx: ptr::null_mut(),
            filter_graph: ptr::null_mut(),
            buffersrc_ctx: ptr::null_mut(),
            layers: Vec::with_capacity(layer_configs.len()),
            workers: Vec::with_capacity(layer_configs.len()),
            src_frame: ptr::null_mut(),
            packet: ptr::null_mut(),
            out_colorspace: ColorSpace::Bt709,
            input_released: Box::new(AtomicBool::new(true)),
            stats: StageStats::new(layer_configs.len()),
        };
        unsafe {
            this.hw_device_ctx = create_hw_device(backend)?;
            let encoder = ff::avcodec_find_encoder_by_name(cstr(encoder_name).as_ptr());
            if encoder.is_null() {
                return Err(VideoError::CodecUnavailable(format!(
                    "libavcodec encoder '{encoder_name}' not present in this ffmpeg build"
                )));
            }
            this.out_colorspace = this.build_filter_graph(layer_configs)?;
            for layer in &mut this.layers {
                layer.enc_ctx = open_layer_encoder(encoder, backend, codec, layer)?;
            }
            for index in 0..this.layers.len() {
                this.workers
                    .push(LayerWorker::spawn(index, codec, this.out_colorspace)?);
            }
            this.src_frame = ff::av_frame_alloc();
            this.packet = ff::av_packet_alloc();
            if this.src_frame.is_null() || this.packet.is_null() {
                return Err(VideoError::EncoderInit(
                    "av_frame/packet_alloc failed".into(),
                ));
            }
        }
        tracing::info!(
            backend = this.backend_name,
            input = %format!("{input_width}x{input_height}"),
            layers = %this
                .layers
                .iter()
                .map(|l| format!("{}x{}@{}/{}kbps", l.config.width, l.config.height, l.config.fps, l.config.bitrate_kbps))
                .collect::<Vec<_>>()
                .join(" "),
            "lavc: shared-upload simulcast encoder ready"
        );
        Ok(this)
    }

    /// Build the one graph: a buffer source, the backend's upload, a split, a
    /// scaler per layer and a buffersink per layer. Each candidate chain is
    /// tried in order (VAAPI prefers a GPU RGB→NV12 conversion and keeps a CPU
    /// conversion as its second candidate, exactly as the per-layer route does).
    unsafe fn build_filter_graph(
        &mut self,
        layer_configs: &[(SimulcastLayer, EncoderConfig)],
    ) -> Result<ColorSpace, VideoError> {
        let sizes: Vec<(u32, u32)> = layer_configs
            .iter()
            .map(|(_, c)| (c.width, c.height))
            .collect();
        let candidates = shared_chain_candidates(
            self.backend,
            self.pixel_format,
            self.input_width,
            self.input_height,
            &sizes,
        );
        let fps = layer_configs
            .iter()
            .map(|(_, c)| c.fps)
            .max()
            .unwrap_or(30)
            .max(1);
        let mut last_err = None;
        let total = candidates.len();
        for (idx, candidate) in candidates.into_iter().enumerate() {
            match self.configure_graph(&candidate.desc, layer_configs, fps) {
                Ok(()) => {
                    if idx == 0 {
                        tracing::info!(backend = ?self.backend, chain = %candidate.desc, "lavc: shared simulcast filter chain active");
                    } else {
                        tracing::warn!(backend = ?self.backend, chain = %candidate.desc, "lavc: primary GPU-convert shared chain unavailable; using CPU-convert chain");
                    }
                    return Ok(candidate.colorspace);
                }
                Err(err) => {
                    if idx + 1 < total {
                        tracing::debug!(backend = ?self.backend, chain = %candidate.desc, error = %err, "lavc: shared chain candidate rejected; trying next");
                    }
                    last_err = Some(err);
                    self.free_filter_graph();
                }
            }
        }
        Err(last_err
            .unwrap_or_else(|| VideoError::EncoderInit("no shared chain candidates".into())))
    }

    unsafe fn configure_graph(
        &mut self,
        desc: &str,
        layer_configs: &[(SimulcastLayer, EncoderConfig)],
        fps: u32,
    ) -> Result<(), VideoError> {
        self.filter_graph = ff::avfilter_graph_alloc();
        if self.filter_graph.is_null() {
            return Err(VideoError::EncoderInit(
                "avfilter_graph_alloc failed".into(),
            ));
        }
        let buffer = ff::avfilter_get_by_name(cstr("buffer").as_ptr());
        let buffersink = ff::avfilter_get_by_name(cstr("buffersink").as_ptr());
        if buffer.is_null() || buffersink.is_null() {
            return Err(VideoError::EncoderInit(
                "libavfilter 'buffer'/'buffersink' unavailable".into(),
            ));
        }
        let src_args = format!(
            "video_size={}x{}:pix_fmt={}:time_base=1/{}:pixel_aspect=1/1",
            self.input_width, self.input_height, self.input_fmt as c_int, fps,
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

        self.layers.clear();
        for (index, (layer, config)) in layer_configs.iter().enumerate() {
            let mut sink = ptr::null_mut();
            let ret = ff::avfilter_graph_create_filter(
                &mut sink,
                buffersink,
                cstr(&format!("out{index}")).as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                self.filter_graph,
            );
            if ret < 0 {
                return Err(VideoError::EncoderInit(format!(
                    "create buffersink {index} failed: {}",
                    av_error_text(ret)
                )));
            }
            let frame = ff::av_frame_alloc();
            if frame.is_null() {
                return Err(VideoError::EncoderInit("av_frame_alloc failed".into()));
            }
            self.layers.push(SharedLayer {
                layer: *layer,
                config: config.clone(),
                sink,
                enc_ctx: ptr::null_mut(),
                frame,
            });
        }

        // Open ends: the source's output "in", and one sink input per layer.
        let outputs = ff::avfilter_inout_alloc();
        if outputs.is_null() {
            return Err(VideoError::EncoderInit(
                "avfilter_inout_alloc failed".into(),
            ));
        }
        (*outputs).name = ff::av_strdup(cstr("in").as_ptr());
        (*outputs).filter_ctx = self.buffersrc_ctx;
        (*outputs).pad_idx = 0;
        (*outputs).next = ptr::null_mut();
        let mut inputs: *mut ff::AVFilterInOut = ptr::null_mut();
        for (index, layer) in self.layers.iter().enumerate().rev() {
            let node = ff::avfilter_inout_alloc();
            if node.is_null() {
                ff::avfilter_inout_free(&mut inputs);
                ff::avfilter_inout_free(&mut { outputs });
                return Err(VideoError::EncoderInit(
                    "avfilter_inout_alloc failed".into(),
                ));
            }
            (*node).name = ff::av_strdup(cstr(&format!("out{index}")).as_ptr());
            (*node).filter_ctx = layer.sink;
            (*node).pad_idx = 0;
            (*node).next = inputs;
            inputs = node;
        }
        let mut outputs = outputs;
        let ret = ff::avfilter_graph_parse_ptr(
            self.filter_graph,
            cstr(desc).as_ptr(),
            &mut inputs,
            &mut outputs,
            ptr::null_mut(),
        );
        ff::avfilter_inout_free(&mut inputs);
        ff::avfilter_inout_free(&mut outputs);
        if ret < 0 {
            return Err(VideoError::EncoderInit(format!(
                "avfilter_graph_parse_ptr('{desc}') failed: {}",
                av_error_text(ret)
            )));
        }
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

    unsafe fn free_filter_graph(&mut self) {
        for layer in self.layers.drain(..) {
            let mut frame = layer.frame;
            if !frame.is_null() {
                ff::av_frame_free(&mut frame);
            }
            let mut ctx = layer.enc_ctx;
            if !ctx.is_null() {
                ff::avcodec_free_context(&mut ctx);
            }
        }
        if !self.filter_graph.is_null() {
            ff::avfilter_graph_free(&mut self.filter_graph);
        }
        self.buffersrc_ctx = ptr::null_mut();
    }

    /// Drain one layer's encoder into `out` (flush, on this thread).
    unsafe fn drain_layer(
        &mut self,
        index: usize,
        out: &mut Vec<EncodedFrame>,
    ) -> Result<(), VideoError> {
        let layer = &self.layers[index];
        drain_packets(
            layer.enc_ctx,
            self.packet,
            self.codec,
            self.out_colorspace,
            layer.layer,
            layer.config.width,
            layer.config.height,
            out,
        )
    }
}

/// Receive every ready packet from `ctx` as encoded frames of `layer`.
#[allow(clippy::too_many_arguments)]
unsafe fn drain_packets(
    ctx: *mut ff::AVCodecContext,
    packet: *mut ff::AVPacket,
    codec: VideoCodec,
    colorspace: ColorSpace,
    layer: SimulcastLayer,
    width: u32,
    height: u32,
    out: &mut Vec<EncodedFrame>,
) -> Result<(), VideoError> {
    loop {
        let ret = ff::avcodec_receive_packet(ctx, packet);
        if ret == AVERROR_EAGAIN || ret == ff::AVERROR_EOF {
            return Ok(());
        }
        if ret < 0 {
            return Err(VideoError::EncodeFailed(format!(
                "{layer:?}: avcodec_receive_packet failed: {}",
                av_error_text(ret)
            )));
        }
        let bytes = std::slice::from_raw_parts((*packet).data, (*packet).size as usize).to_vec();
        out.push(EncodedFrame {
            data: bytes,
            codec,
            pts: (*packet).pts,
            is_keyframe: ((*packet).flags & ff::AV_PKT_FLAG_KEY) != 0,
            layer: Some(layer),
            width,
            height,
            colorspace,
        });
        ff::av_packet_unref(packet);
    }
}

/// A raw pointer handed to a layer thread. The owner waits for the thread's
/// answer before touching the pointee again, so it is never shared at once.
struct SendPtr<T>(*mut T);
// Safety: see the type's doc; access alternates strictly between the threads.
unsafe impl<T> Send for SendPtr<T> {}

enum LayerJob {
    Encode {
        ctx: SendPtr<ff::AVCodecContext>,
        frame: SendPtr<ff::AVFrame>,
        layer: SimulcastLayer,
        width: u32,
        height: u32,
    },
}

type LayerAnswer = Result<(Vec<EncodedFrame>, Duration), VideoError>;

/// One layer's encode thread: sends the GPU frame to that layer's encoder and
/// returns its packets.
struct LayerWorker {
    jobs: Option<mpsc::Sender<LayerJob>>,
    answers: mpsc::Receiver<LayerAnswer>,
    handle: Option<JoinHandle<()>>,
}

impl LayerWorker {
    fn spawn(index: usize, codec: VideoCodec, colorspace: ColorSpace) -> Result<Self, VideoError> {
        let (job_tx, job_rx) = mpsc::channel::<LayerJob>();
        let (answer_tx, answer_rx) = mpsc::channel::<LayerAnswer>();
        let handle = thread::Builder::new()
            .name(format!("lavc-simulcast-{index}"))
            .spawn(move || {
                let mut packet = unsafe { ff::av_packet_alloc() };
                while let Ok(job) = job_rx.recv() {
                    let LayerJob::Encode {
                        ctx,
                        frame,
                        layer,
                        width,
                        height,
                    } = job;
                    let started = Instant::now();
                    let answer = if packet.is_null() {
                        Err(VideoError::EncodeFailed("av_packet_alloc failed".into()))
                    } else {
                        unsafe {
                            let ret = ff::avcodec_send_frame(ctx.0, frame.0);
                            if ret < 0 {
                                Err(VideoError::EncodeFailed(format!(
                                    "{layer:?}: avcodec_send_frame failed: {}",
                                    av_error_text(ret)
                                )))
                            } else {
                                let mut frames = Vec::with_capacity(1);
                                drain_packets(
                                    ctx.0,
                                    packet,
                                    codec,
                                    colorspace,
                                    layer,
                                    width,
                                    height,
                                    &mut frames,
                                )
                                .map(|()| (frames, started.elapsed()))
                            }
                        }
                    };
                    if answer_tx.send(answer).is_err() {
                        break;
                    }
                }
                if !packet.is_null() {
                    unsafe { ff::av_packet_free(&mut packet) };
                }
            })
            .map_err(|err| VideoError::EncoderInit(format!("spawn layer {index} thread: {err}")))?;
        Ok(Self {
            jobs: Some(job_tx),
            answers: answer_rx,
            handle: Some(handle),
        })
    }

    fn submit(&self, job: LayerJob) -> Result<(), VideoError> {
        self.jobs
            .as_ref()
            .ok_or_else(|| VideoError::EncodeFailed("layer thread stopped".into()))?
            .send(job)
            .map_err(|_| VideoError::EncodeFailed("layer thread exited".into()))
    }

    fn wait(&self) -> LayerAnswer {
        self.answers
            .recv()
            .map_err(|_| VideoError::EncodeFailed("layer thread exited mid-frame".into()))?
    }
}

impl Drop for LayerWorker {
    fn drop(&mut self) {
        // Closing the job channel ends the thread's loop.
        self.jobs = None;
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Free callback for the caller's pixels wrapped as an `AVBufferRef`: the
/// memory belongs to the caller, so only record that the graph let it go.
unsafe extern "C" fn release_borrowed_input(opaque: *mut c_void, _data: *mut u8) {
    if !opaque.is_null() {
        (*(opaque as *const AtomicBool)).store(true, Ordering::Release);
    }
}

unsafe fn open_layer_encoder(
    encoder: *const ff::AVCodec,
    backend: LavcBackend,
    codec: VideoCodec,
    layer: &SharedLayer,
) -> Result<*mut ff::AVCodecContext, VideoError> {
    let hw_frames = ff::av_buffersink_get_hw_frames_ctx(layer.sink);
    if hw_frames.is_null() {
        return Err(VideoError::EncoderInit(format!(
            "{}: shared filter graph produced no hardware frames for {:?}",
            backend.display_name(codec),
            layer.layer
        )));
    }
    let mut ctx = ff::avcodec_alloc_context3(encoder);
    if ctx.is_null() {
        return Err(VideoError::EncoderInit(
            "avcodec_alloc_context3 failed".into(),
        ));
    }
    configure_encoder_context(ctx, backend, codec, &layer.config, hw_frames);
    let ret = ff::avcodec_open2(ctx, encoder, ptr::null_mut());
    if ret < 0 {
        ff::avcodec_free_context(&mut ctx);
        return Err(VideoError::EncoderInit(format!(
            "{} {:?} {}x{}: avcodec_open2 failed: {}",
            backend.display_name(codec),
            layer.layer,
            layer.config.width,
            layer.config.height,
            av_error_text(ret)
        )));
    }
    Ok(ctx)
}

impl SharedSimulcastBackend for LavcSimulcastEncoder {
    fn encode_layers(
        &mut self,
        pts: i64,
        data: &[u8],
        keyframes: &[bool],
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        let expected = self
            .pixel_format
            .frame_size(self.input_width, self.input_height);
        if data.len() != expected {
            return Err(VideoError::FrameSizeMismatch {
                expected,
                actual: data.len(),
            });
        }
        if keyframes.len() != self.layers.len() {
            return Err(VideoError::EncodeFailed(format!(
                "keyframe flags for {} layers, encoder has {}",
                keyframes.len(),
                self.layers.len()
            )));
        }
        let started = Instant::now();
        let mut out = Vec::with_capacity(self.layers.len());
        unsafe {
            // 1. Hand the caller's pixels to the graph by reference. A
            // non-refcounted frame would be copied by the buffer source; this
            // buffer's free callback only records the release, and the PUSH flag
            // runs the upload before the call returns.
            self.input_released.store(false, Ordering::Release);
            let buf = ff::av_buffer_create(
                data.as_ptr() as *mut u8,
                data.len(),
                Some(release_borrowed_input),
                &*self.input_released as *const AtomicBool as *mut c_void,
                ff::AV_BUFFER_FLAG_READONLY as c_int,
            );
            if buf.is_null() {
                self.input_released.store(true, Ordering::Release);
                return Err(VideoError::EncodeFailed("av_buffer_create failed".into()));
            }
            let src = self.src_frame;
            (*src).buf[0] = buf;
            (*src).format = self.input_fmt as c_int;
            (*src).width = self.input_width as c_int;
            (*src).height = self.input_height as c_int;
            (*src).pts = pts;
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
                ff::av_frame_unref(src);
                return Err(VideoError::EncodeFailed(format!(
                    "av_image_fill_arrays failed: {}",
                    av_error_text(ret)
                )));
            }
            // The buffer source takes the frame's reference (no KEEP_REF).
            let ret = ff::av_buffersrc_add_frame_flags(
                self.buffersrc_ctx,
                src,
                ff::AV_BUFFERSRC_FLAG_PUSH as c_int,
            );
            if ret < 0 {
                ff::av_frame_unref(src);
                return Err(VideoError::EncodeFailed(format!(
                    "av_buffersrc_add_frame failed: {}",
                    av_error_text(ret)
                )));
            }
            let uploaded = Instant::now();

            // 2. One scaled GPU frame per layer.
            for index in 0..self.layers.len() {
                let layer = &self.layers[index];
                let ret = ff::av_buffersink_get_frame(layer.sink, layer.frame);
                if ret < 0 {
                    return Err(VideoError::EncodeFailed(format!(
                        "layer {index} ({:?}): av_buffersink_get_frame failed: {}",
                        layer.layer,
                        av_error_text(ret)
                    )));
                }
            }
            // The graph must be done with the caller's pixels now: they are
            // only borrowed for this call.
            if !self.input_released.load(Ordering::Acquire) {
                return Err(VideoError::EncodeFailed(
                    "the shared filter graph kept the input frame after the upload; refusing to \
                     let it read a buffer the caller is about to reuse"
                        .into(),
                ));
            }
            let scaled = Instant::now();

            // 3. Encode every layer at once, each on its own thread. Every
            // submitted job is waited for, even after an error, so no answer is
            // left for the next frame to read.
            let mut first_error = None;
            let mut submitted = 0;
            for ((layer, worker), &keyframe) in self.layers.iter().zip(&self.workers).zip(keyframes)
            {
                apply_keyframe_request(layer.frame, keyframe);
                (*layer.frame).pts = pts;
                let job = LayerJob::Encode {
                    ctx: SendPtr(layer.enc_ctx),
                    frame: SendPtr(layer.frame),
                    layer: layer.layer,
                    width: layer.config.width,
                    height: layer.config.height,
                };
                if let Err(err) = worker.submit(job) {
                    first_error = Some(err);
                    break;
                }
                submitted += 1;
            }
            for index in 0..submitted {
                let result = self.workers[index].wait();
                ff::av_frame_unref(self.layers[index].frame);
                match result {
                    Ok((frames, elapsed)) => {
                        self.stats.record_layer(index, elapsed);
                        out.extend(frames);
                    }
                    Err(err) => {
                        first_error.get_or_insert(err);
                    }
                }
            }
            for layer in &self.layers[submitted..] {
                ff::av_frame_unref(layer.frame);
            }
            if let Some(err) = first_error {
                return Err(err);
            }
            let done = Instant::now();
            self.stats.record_frame(
                uploaded - started,
                scaled - uploaded,
                done - scaled,
                done - started,
            );
        }
        Ok(out)
    }

    fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        let mut out = Vec::new();
        unsafe {
            for index in 0..self.layers.len() {
                let ret = ff::avcodec_send_frame(self.layers[index].enc_ctx, ptr::null());
                if ret < 0 && ret != ff::AVERROR_EOF {
                    return Err(VideoError::EncodeFailed(format!(
                        "layer {index}: flush failed: {}",
                        av_error_text(ret)
                    )));
                }
                self.drain_layer(index, &mut out)?;
            }
        }
        Ok(out)
    }

    fn set_layer_bitrate(&mut self, index: usize, bitrate_kbps: u32) -> Result<bool, VideoError> {
        let Some(layer) = self.layers.get_mut(index) else {
            return Ok(false);
        };
        let kbps = bitrate_kbps.max(1);
        if kbps == layer.config.bitrate_kbps {
            return Ok(false);
        }
        layer.config.bitrate_kbps = kbps;
        unsafe {
            match self.backend {
                // NVENC reconfigures its rate control in place when the
                // context's rates change (libavcodec's nvenc compares them on
                // every frame): no new session, no rebuilt graph.
                // A constant-quality layer keeps its quality target and moves
                // only its ceiling; a Film layer (a target rate) moves both.
                LavcBackend::Nvenc => {
                    retarget_nvenc_in_place(layer.enc_ctx, &layer.config, kbps);
                }
                // VAAPI and QSV fix the rate at open: reopen this layer's
                // encoder on the same graph output (the upload and the other
                // layers are untouched).
                LavcBackend::Vaapi | LavcBackend::Qsv => {
                    let encoder = (*layer.enc_ctx).codec;
                    let reopened = open_layer_encoder(encoder, self.backend, self.codec, layer)?;
                    let mut old = std::mem::replace(&mut layer.enc_ctx, reopened);
                    ff::avcodec_free_context(&mut old);
                }
            }
        }
        tracing::info!(
            backend = self.backend_name,
            layer = ?self.layers[index].layer,
            kbps,
            "lavc: simulcast layer bitrate retargeted"
        );
        Ok(true)
    }

    fn backend_name(&self) -> &'static str {
        self.backend_name
    }

    fn layer_count(&self) -> usize {
        self.layers.len()
    }

    fn stage_report(&mut self) -> Option<String> {
        self.stats.report(self.backend_name)
    }
}

impl Drop for LavcSimulcastEncoder {
    fn drop(&mut self) {
        // Join the layer threads before their encoders are freed.
        self.workers.clear();
        unsafe {
            if !self.packet.is_null() {
                ff::av_packet_free(&mut self.packet);
            }
            if !self.src_frame.is_null() {
                ff::av_frame_free(&mut self.src_frame);
            }
            self.free_filter_graph();
            if !self.hw_device_ctx.is_null() {
                ff::av_buffer_unref(&mut self.hw_device_ctx);
            }
        }
    }
}

/// One candidate graph description plus the colorspace it produces.
struct SharedChain {
    desc: String,
    colorspace: ColorSpace,
}

/// The shared graph descriptions for a backend, best first. `[in]` is the
/// buffer source and `[outN]` layer N's sink.
fn shared_chain_candidates(
    backend: LavcBackend,
    pixel_format: PixelFormat,
    input_width: u32,
    input_height: u32,
    sizes: &[(u32, u32)],
) -> Vec<SharedChain> {
    const CPU_709_NV12: &str = "scale=out_color_matrix=bt709:out_range=tv,format=nv12";
    let same = |(w, h): (u32, u32)| (w, h) == (input_width, input_height);
    match backend {
        LavcBackend::Nvenc => {
            // Packed RGB through upload and scale; NVENC converts to NV12 with
            // its fixed BT.601 matrix (measured, see encoder.rs), so that is
            // the honest colorspace of this path.
            let fmt = av_input_format_name(pixel_format);
            let per_layer: Vec<String> = sizes
                .iter()
                .map(|&(w, h)| {
                    if same((w, h)) {
                        "null".to_string()
                    } else {
                        format!("scale_cuda=w={w}:h={h}:format={fmt}")
                    }
                })
                .collect();
            vec![SharedChain {
                desc: compose_shared_chain("hwupload_cuda", &per_layer),
                colorspace: ColorSpace::Bt601,
            }]
        }
        LavcBackend::Vaapi => {
            let gpu: Vec<String> = sizes
                .iter()
                .map(|&(w, h)| {
                    format!(
                        "scale_vaapi=w={w}:h={h}:format=nv12:out_color_matrix=bt709:out_range=limited"
                    )
                })
                .collect();
            let cpu: Vec<String> = sizes
                .iter()
                .map(|&(w, h)| {
                    if same((w, h)) {
                        "null".to_string()
                    } else {
                        format!("scale_vaapi=w={w}:h={h}:format=nv12")
                    }
                })
                .collect();
            vec![
                SharedChain {
                    desc: compose_shared_chain("hwupload", &gpu),
                    colorspace: ColorSpace::Bt709,
                },
                SharedChain {
                    desc: compose_shared_chain(&format!("{CPU_709_NV12},hwupload"), &cpu),
                    colorspace: ColorSpace::Bt709,
                },
            ]
        }
        LavcBackend::Qsv => {
            let per_layer: Vec<String> = sizes
                .iter()
                .map(|&(w, h)| {
                    if same((w, h)) {
                        "null".to_string()
                    } else {
                        format!("vpp_qsv=w={w}:h={h}")
                    }
                })
                .collect();
            vec![SharedChain {
                desc: compose_shared_chain(&format!("{CPU_709_NV12},hwupload"), &per_layer),
                colorspace: ColorSpace::Bt709,
            }]
        }
    }
}

/// `[in]upload,split=N[s0]…;[s0]layer0[out0];…` (no split for one layer).
fn compose_shared_chain(upload: &str, per_layer: &[String]) -> String {
    if per_layer.len() == 1 {
        return format!("[in]{upload},{}[out0]", per_layer[0]);
    }
    let labels: String = (0..per_layer.len()).map(|i| format!("[s{i}]")).collect();
    let mut desc = format!("[in]{upload},split={}{labels}", per_layer.len());
    for (i, filter) in per_layer.iter().enumerate() {
        desc.push_str(&format!(";[s{i}]{filter}[out{i}]"));
    }
    desc
}

/// Per-stage encode timing, summarized every [`STAGE_REPORT_INTERVAL`].
struct StageStats {
    window_start: Instant,
    frames: u32,
    upload: StageAccumulator,
    scale: StageAccumulator,
    encode: StageAccumulator,
    total: StageAccumulator,
    layers: Vec<StageAccumulator>,
}

#[derive(Default, Clone, Copy)]
struct StageAccumulator {
    sum: Duration,
    max: Duration,
}

impl StageAccumulator {
    fn add(&mut self, value: Duration) {
        self.sum += value;
        self.max = self.max.max(value);
    }

    fn summary(&self, frames: u32) -> String {
        let avg = self.sum.as_secs_f64() * 1000.0 / f64::from(frames.max(1));
        format!("{avg:.2}/{:.2}", self.max.as_secs_f64() * 1000.0)
    }
}

impl StageStats {
    fn new(layers: usize) -> Self {
        Self {
            window_start: Instant::now(),
            frames: 0,
            upload: StageAccumulator::default(),
            scale: StageAccumulator::default(),
            encode: StageAccumulator::default(),
            total: StageAccumulator::default(),
            layers: vec![StageAccumulator::default(); layers],
        }
    }

    fn record_layer(&mut self, index: usize, value: Duration) {
        if let Some(layer) = self.layers.get_mut(index) {
            layer.add(value);
        }
    }

    fn record_frame(
        &mut self,
        upload: Duration,
        scale: Duration,
        encode: Duration,
        total: Duration,
    ) {
        self.frames += 1;
        self.upload.add(upload);
        self.scale.add(scale);
        self.encode.add(encode);
        self.total.add(total);
    }

    fn report(&mut self, backend: &str) -> Option<String> {
        let elapsed = self.window_start.elapsed();
        if elapsed < STAGE_REPORT_INTERVAL || self.frames == 0 {
            return None;
        }
        let fps = f64::from(self.frames) / elapsed.as_secs_f64();
        let layers = self
            .layers
            .iter()
            .enumerate()
            .map(|(i, layer)| format!("L{i} {}", layer.summary(self.frames)))
            .collect::<Vec<_>>()
            .join(", ");
        let line = format!(
            "screen encode stages ({backend}, ms avg/max over {} frames, {fps:.1} fps): \
             upload {} | scale {} | encode {} ({layers}) | total {}",
            self.frames,
            self.upload.summary(self.frames),
            self.scale.summary(self.frames),
            self.encode.summary(self.frames),
            self.total.summary(self.frames),
        );
        *self = Self::new(self.layers.len());
        Some(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_chain_splits_one_upload_to_every_layer() {
        let chains = shared_chain_candidates(
            LavcBackend::Nvenc,
            PixelFormat::Bgra,
            5120,
            1440,
            &[(1280, 360), (2560, 720), (5120, 1440)],
        );
        assert_eq!(
            chains[0].desc,
            "[in]hwupload_cuda,split=3[s0][s1][s2];\
             [s0]scale_cuda=w=1280:h=360:format=bgra[out0];\
             [s1]scale_cuda=w=2560:h=720:format=bgra[out1];\
             [s2]null[out2]"
        );
        assert_eq!(chains[0].desc.matches("hwupload").count(), 1);
    }

    #[test]
    fn single_layer_chain_has_no_split() {
        let chains = shared_chain_candidates(
            LavcBackend::Nvenc,
            PixelFormat::Bgra,
            1920,
            1080,
            &[(1280, 720)],
        );
        assert_eq!(
            chains[0].desc,
            "[in]hwupload_cuda,scale_cuda=w=1280:h=720:format=bgra[out0]"
        );
    }

    #[test]
    fn vaapi_keeps_a_cpu_convert_candidate() {
        let chains = shared_chain_candidates(
            LavcBackend::Vaapi,
            PixelFormat::Bgra,
            1920,
            1080,
            &[(640, 360), (1920, 1080)],
        );
        assert_eq!(chains.len(), 2);
        assert!(chains[0].desc.starts_with("[in]hwupload,split=2"));
        assert!(chains[1].desc.contains("format=nv12,hwupload,split=2"));
        assert!(chains[1].desc.ends_with("[s1]null[out1]"));
    }
}
