//! DRM-PRIME (dma-buf) → VAAPI zero-copy screen-capture import (D2, Linux).
//!
//! On Linux the compositor hands PipeWire frames that already live in GPU
//! memory. The SHM path in [`super::encoder`] copies those frames down to a CPU
//! `Vec<u8>`, then `hwupload`s them straight back to the GPU — two full-frame
//! bus transfers per frame that this path removes. Here the compositor's
//! dma-buf is wrapped as an `AV_PIX_FMT_DRM_PRIME` frame and `hwmap`ped directly
//! into a VAAPI surface (`derive_device=vaapi:mode=direct`), so the pixels never
//! leave VRAM: capture → `scale_vaapi` (RGB→NV12, BT.709) → `*_vaapi` encoder.
//!
//! # Backend scope
//!
//! VAAPI only. NVENC dma-buf import (CUDA `cuImportExternalMemory` / EGL interop)
//! is deliberately absent — see the module notes in the change report. NVENC
//! screen capture stays on the SHM path in [`super::encoder`].
//!
//! # Status: compiles, disabled by default, not yet wired to the capture loop
//!
//! Every symbol here builds against the pinned `ffmpeg_sys_next` (verified: the
//! DRM hwcontext descriptors, `av_hwframe`/`hwmap`, and `av_buffersrc_parameters`
//! are all bound). What it is **not** is hardware-validated: this machine's
//! `cargo check` cannot exercise a real compositor dma-buf through a GPU. Two
//! things must land before the route is switched on (see D3 selector in
//! `video_pipeline.rs` and the change report):
//!
//! 1. **The scap carrier.** `scap::frame::VideoFrame` has no dma-buf variant, so
//!    the exported `(fd, stride, offset, modifier, fourcc)` cannot reach this
//!    encoder through scap's public API yet. That enum + `Options` route flag
//!    are outside this agent's owned files.
//! 2. **Buffer-lifetime handoff.** The capture loop's keep-latest/pace model
//!    (screen_capture.rs) copies today precisely so a PipeWire buffer can be
//!    re-queued immediately. A dma-buf must be held (its fd kept live, its
//!    PipeWire buffer un-queued) until the encode that consumes it completes,
//!    or the compositor may overwrite it in place. [`DmaBufVaapiEncoder`] takes
//!    ownership of the fds and closes them when the mapped VAAPI surface is
//!    freed (after encode), which is the encoder side of that contract; the
//!    capture side owns the un-queue timing.
//!
//! Until both land, [`probe_dmabuf_vaapi_import`] is the capability gate and the
//! route selector keeps SHM.

use super::encoder::{apply_keyframe_request, configure_encoder_context};
use super::{av_error_text, cstr, require_encodable, LavcBackend, AVERROR_EAGAIN};
use crate::video::{ColorSpace, EncodedFrame, EncoderConfig, VideoCodec, VideoError};
use ffmpeg_sys_next as ff;
use std::ffi::c_int;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::raw::c_void;
use std::ptr;

// ── DRM format constants ─────────────────────────────────────────────
//
// ffmpeg's DRM hwcontext binds the descriptor structs but not libdrm's
// `<drm/drm_fourcc.h>` constants, so the handful this path branches on are
// defined here with their canonical values.

/// `DRM_FORMAT_MOD_LINEAR` — un-tiled memory layout.
pub const DRM_FORMAT_MOD_LINEAR: u64 = 0;

/// `DRM_FORMAT_MOD_INVALID` — "modifier unknown". A driver that cannot report a
/// modifier uses this; we refuse to import such a surface because its tiling is
/// unknown and a wrong guess yields corrupt pixels (fail loud, never guess).
pub const DRM_FORMAT_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;

const fn fourcc(a: u8, b: u8, c: u8, d: u8) -> u32 {
    (a as u32) | ((b as u32) << 8) | ((c as u32) << 16) | ((d as u32) << 24)
}

/// `DRM_FORMAT_XRGB8888` — 32bpp, byte order B,G,R,X in memory (DRM fourccs are
/// little-endian), i.e. ffmpeg `AV_PIX_FMT_BGR0`.
pub const DRM_FORMAT_XRGB8888: u32 = fourcc(b'X', b'R', b'2', b'4');
/// `DRM_FORMAT_ARGB8888` → `AV_PIX_FMT_BGRA`.
pub const DRM_FORMAT_ARGB8888: u32 = fourcc(b'A', b'R', b'2', b'4');
/// `DRM_FORMAT_XBGR8888` → `AV_PIX_FMT_RGB0`.
pub const DRM_FORMAT_XBGR8888: u32 = fourcc(b'X', b'B', b'2', b'4');
/// `DRM_FORMAT_ABGR8888` → `AV_PIX_FMT_RGBA`.
pub const DRM_FORMAT_ABGR8888: u32 = fourcc(b'A', b'B', b'2', b'4');

/// Map a DRM fourcc to the ffmpeg *software* pixel format that the DRM
/// hwcontext should tag the imported surface with. Only the packed-32bpp RGB
/// layouts a compositor produces for screen capture are handled; anything else
/// is rejected (fail loud rather than mis-tag the surface).
fn drm_fourcc_to_sw_pix_fmt(drm_fourcc: u32) -> Option<ff::AVPixelFormat> {
    Some(match drm_fourcc {
        DRM_FORMAT_XRGB8888 => ff::AVPixelFormat::AV_PIX_FMT_BGR0,
        DRM_FORMAT_ARGB8888 => ff::AVPixelFormat::AV_PIX_FMT_BGRA,
        DRM_FORMAT_XBGR8888 => ff::AVPixelFormat::AV_PIX_FMT_RGB0,
        DRM_FORMAT_ABGR8888 => ff::AVPixelFormat::AV_PIX_FMT_RGBA,
        _ => return None,
    })
}

// ── dma-buf descriptor (carrier-agnostic) ────────────────────────────

/// One DRM object (a single dma-buf fd) backing a frame.
#[derive(Debug, Clone, Copy)]
pub struct DmaBufObject {
    /// dma-buf file descriptor. [`DmaBufVaapiEncoder::encode_dmabuf`] takes
    /// ownership and closes it once the mapped VAAPI surface is freed.
    pub fd: i32,
    /// Total size of the object in bytes.
    pub size: usize,
    /// DRM format modifier (`DRM_FORMAT_MOD_*`) describing the tiling.
    pub modifier: u64,
}

/// One image plane, referencing an object by index.
#[derive(Debug, Clone, Copy)]
pub struct DmaBufPlane {
    /// Index into [`DmaBufDescriptor::objects`].
    pub object_index: usize,
    /// Byte offset of the plane within its object.
    pub offset: u32,
    /// Row pitch (stride) of the plane in bytes.
    pub pitch: u32,
}

/// A compositor dma-buf frame, mirroring `AVDRMFrameDescriptor` in the shape a
/// capture backend can populate without pulling in ffmpeg types. Screen-capture
/// RGB surfaces are single-object single-plane; the general multi-object form is
/// kept so a planar (NV12) capture surface maps too.
#[derive(Debug, Clone)]
pub struct DmaBufDescriptor {
    pub width: u32,
    pub height: u32,
    /// DRM fourcc (`DRM_FORMAT_*`) of the layer.
    pub drm_fourcc: u32,
    /// 1..=4 backing objects (dma-buf fds).
    pub objects: Vec<DmaBufObject>,
    /// 1..=4 planes (a single layer).
    pub planes: Vec<DmaBufPlane>,
}

impl DmaBufDescriptor {
    fn validate(&self, input_width: u32, input_height: u32) -> Result<(), VideoError> {
        if self.width != input_width || self.height != input_height {
            // Route is fixed at stream start (D3): a mid-stream dimension change
            // is a hard error, never a silent re-negotiation.
            return Err(VideoError::InvalidDimensions {
                width: self.width,
                height: self.height,
            });
        }
        if self.objects.is_empty() || self.objects.len() > 4 {
            return Err(VideoError::EncodeFailed(format!(
                "dma-buf descriptor has {} objects (expected 1..=4)",
                self.objects.len()
            )));
        }
        if self.planes.is_empty() || self.planes.len() > 4 {
            return Err(VideoError::EncodeFailed(format!(
                "dma-buf descriptor has {} planes (expected 1..=4)",
                self.planes.len()
            )));
        }
        for plane in &self.planes {
            if plane.object_index >= self.objects.len() {
                return Err(VideoError::EncodeFailed(format!(
                    "dma-buf plane references object {} but only {} present",
                    plane.object_index,
                    self.objects.len()
                )));
            }
        }
        for obj in &self.objects {
            if obj.fd < 0 {
                return Err(VideoError::EncodeFailed(
                    "dma-buf object has an invalid fd".into(),
                ));
            }
            if obj.modifier == DRM_FORMAT_MOD_INVALID {
                return Err(VideoError::EncodeFailed(
                    "dma-buf object modifier is DRM_FORMAT_MOD_INVALID; refusing to import a surface whose tiling is unknown".into(),
                ));
            }
        }
        Ok(())
    }

    /// Close every backing dma-buf fd. `encode_dmabuf` owns the fds until they
    /// transfer into the imported frame's `AVBuffer` free callback; on any error
    /// path that rejects the descriptor *before* that transfer, this closes them
    /// so a rejected frame never leaks an fd (fd exhaustion under a churning
    /// mid-stream reject). Safe to call exactly once on such a path — the fds have
    /// no other owner yet.
    fn close_fds(&self) {
        for obj in &self.objects {
            if obj.fd >= 0 {
                // SAFETY: on a reject path ownership never moved into the AVBuffer,
                // so this is the sole owner closing each fd exactly once.
                unsafe {
                    drop(OwnedFd::from_raw_fd(obj.fd));
                }
            }
        }
    }
}

// ── Capability probe ─────────────────────────────────────────────────

/// Whether this machine can create a DRM device and derive a VAAPI device from
/// it — the minimum needed to `hwmap` a dma-buf into VAAPI. Called once at
/// stream start by the route selector (D3); the decision is then fixed.
///
/// Honours `PARACORD_VAAPI_DEVICE` (a DRM render node like `/dev/dri/renderD128`)
/// exactly as the SHM VAAPI path does, so probe and real construction target the
/// same device.
pub fn probe_dmabuf_vaapi_import() -> bool {
    unsafe {
        let mut drm: *mut ff::AVBufferRef = ptr::null_mut();
        let device = vaapi_device_cstring();
        let device_ptr = device.as_ref().map_or(ptr::null(), |c| c.as_ptr());
        let ret = ff::av_hwdevice_ctx_create(
            &mut drm,
            ff::AVHWDeviceType::AV_HWDEVICE_TYPE_DRM,
            device_ptr,
            ptr::null_mut(),
            0,
        );
        if ret < 0 || drm.is_null() {
            return false;
        }
        let mut vaapi: *mut ff::AVBufferRef = ptr::null_mut();
        let ret = ff::av_hwdevice_ctx_create_derived(
            &mut vaapi,
            ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
            drm,
            0,
        );
        let ok = ret >= 0 && !vaapi.is_null();
        if !vaapi.is_null() {
            ff::av_buffer_unref(&mut vaapi);
        }
        ff::av_buffer_unref(&mut drm);
        ok
    }
}

/// The DRM render node override shared by the probe and real construction.
fn vaapi_device_cstring() -> Option<std::ffi::CString> {
    std::env::var("PARACORD_VAAPI_DEVICE")
        .ok()
        .map(|p| cstr(&p))
}

// ── Encoder ──────────────────────────────────────────────────────────

/// A VAAPI hardware encoder fed by imported compositor dma-bufs (zero upload).
///
/// Construction mirrors [`super::encoder::LavcEncoder`]'s no-runtime-switching
/// discipline: the DRM device, derived VAAPI device, filter graph and encoder
/// are chosen once and fixed. The one difference is the front of the graph —
/// a DRM-PRIME buffer source + `hwmap` instead of a software buffer +
/// `hwupload`.
pub struct DmaBufVaapiEncoder {
    config: EncoderConfig,
    input_width: u32,
    input_height: u32,
    codec: VideoCodec,
    drm_fourcc: u32,
    pipe: DmaBufPipeline,
    frames_submitted: u64,
}

// Safety: every raw pointer inside `DmaBufPipeline` is created, used, and freed
// only through `&mut self`, mirroring `LavcEncoder`.
unsafe impl Send for DmaBufVaapiEncoder {}

impl DmaBufVaapiEncoder {
    /// Build the import encoder for `input_width`×`input_height` dma-bufs of
    /// `drm_fourcc`, producing `config.width`×`config.height` `codec` output.
    ///
    /// Fails loudly if the fourcc is unsupported, the codec has no VAAPI encoder
    /// (VP9), or any GPU object cannot be created — there is no fallback to SHM
    /// from here; the route selector decides SHM-vs-dmabuf before this is called.
    pub fn new(
        codec: VideoCodec,
        config: EncoderConfig,
        input_width: u32,
        input_height: u32,
        drm_fourcc: u32,
    ) -> Result<Self, VideoError> {
        require_encodable(codec)?;
        config.validate()?;
        if input_width == 0 || input_height == 0 {
            return Err(VideoError::InvalidDimensions {
                width: input_width,
                height: input_height,
            });
        }
        if drm_fourcc_to_sw_pix_fmt(drm_fourcc).is_none() {
            return Err(VideoError::EncoderInit(format!(
                "dma-buf import: unsupported DRM fourcc {drm_fourcc:#010x}"
            )));
        }
        let pipe = DmaBufPipeline::build(codec, &config, input_width, input_height, drm_fourcc)?;
        tracing::info!(
            codec = ?codec,
            input = format!("{input_width}x{input_height}"),
            output = format!("{}x{}", config.width, config.height),
            fourcc = format!("{drm_fourcc:#010x}"),
            "lavc: dma-buf → VAAPI import encoder active (zero-copy screen capture)"
        );
        Ok(Self {
            config,
            input_width,
            input_height,
            codec,
            drm_fourcc,
            pipe,
            frames_submitted: 0,
        })
    }

    /// Encode one imported dma-buf frame. Takes ownership of every fd in
    /// `desc.objects`; they are closed once the mapped VAAPI surface backing this
    /// frame is released (after the encode consumes it).
    pub fn encode_dmabuf(
        &mut self,
        pts: i64,
        desc: DmaBufDescriptor,
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        if desc.drm_fourcc != self.drm_fourcc {
            desc.close_fds();
            return Err(VideoError::EncodeFailed(format!(
                "dma-buf fourcc changed mid-stream ({:#010x} → {:#010x}); route is fixed at stream start",
                self.drm_fourcc, desc.drm_fourcc
            )));
        }
        if let Err(err) = desc.validate(self.input_width, self.input_height) {
            desc.close_fds();
            return Err(err);
        }
        self.frames_submitted = self.frames_submitted.saturating_add(1);
        self.pipe
            .encode_frame(pts, desc, force_keyframe, self.codec)
    }

    /// Flush any buffered packets (normally none — low-delay, no B-frames).
    pub fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        self.pipe.flush(self.codec)
    }

    pub fn config(&self) -> &EncoderConfig {
        &self.config
    }

    pub fn codec(&self) -> VideoCodec {
        self.codec
    }

    pub fn backend_name(&self) -> &'static str {
        LavcBackend::Vaapi.display_name(self.codec)
    }

    pub fn input_dimensions(&self) -> (u32, u32) {
        (self.input_width, self.input_height)
    }
}

// ── Pipeline ─────────────────────────────────────────────────────────

/// The libavcodec/libavfilter objects backing one import encoder. Owned;
/// [`Drop`] frees them in reverse construction order.
struct DmaBufPipeline {
    drm_device_ctx: *mut ff::AVBufferRef,
    drm_frames_ctx: *mut ff::AVBufferRef,
    enc_ctx: *mut ff::AVCodecContext,
    filter_graph: *mut ff::AVFilterGraph,
    buffersrc_ctx: *mut ff::AVFilterContext,
    buffersink_ctx: *mut ff::AVFilterContext,
    src_frame: *mut ff::AVFrame,
    filt_frame: *mut ff::AVFrame,
    packet: *mut ff::AVPacket,
    out_width: u32,
    out_height: u32,
    /// Always BT.709 (C1): `scale_vaapi` forces `out_color_matrix=bt709` and the
    /// encoder context tags the bitstream to match. Recorded so
    /// [`EncodedFrame::colorspace`] never lies.
    out_colorspace: ColorSpace,
}

impl DmaBufPipeline {
    fn build(
        codec: VideoCodec,
        config: &EncoderConfig,
        input_width: u32,
        input_height: u32,
        drm_fourcc: u32,
    ) -> Result<Self, VideoError> {
        let encoder_name = LavcBackend::Vaapi.encoder_name(codec).ok_or_else(|| {
            VideoError::CodecUnavailable(format!("{codec:?} has no VAAPI encoder"))
        })?;
        let sw_fmt = drm_fourcc_to_sw_pix_fmt(drm_fourcc).ok_or_else(|| {
            VideoError::EncoderInit(format!("unsupported DRM fourcc {drm_fourcc:#010x}"))
        })?;

        let mut pipe = DmaBufPipeline {
            drm_device_ctx: ptr::null_mut(),
            drm_frames_ctx: ptr::null_mut(),
            enc_ctx: ptr::null_mut(),
            filter_graph: ptr::null_mut(),
            buffersrc_ctx: ptr::null_mut(),
            buffersink_ctx: ptr::null_mut(),
            src_frame: ptr::null_mut(),
            filt_frame: ptr::null_mut(),
            packet: ptr::null_mut(),
            out_width: config.width,
            out_height: config.height,
            out_colorspace: ColorSpace::Bt709,
        };

        unsafe {
            // 1. DRM device (source of the imported dma-bufs).
            pipe.drm_device_ctx = create_drm_device()?;

            // 2. DRM hardware frames context describing the surfaces we import.
            //    `initial_pool_size = 0`: we supply the backing buffer per frame
            //    (the imported dma-buf), so no internal pool is allocated.
            pipe.drm_frames_ctx =
                create_drm_frames_ctx(pipe.drm_device_ctx, sw_fmt, input_width, input_height)?;

            // 3. Encoder must exist before the graph so a missing encoder fails
            //    cheaply.
            let encoder = ff::avcodec_find_encoder_by_name(cstr(encoder_name).as_ptr());
            if encoder.is_null() {
                return Err(VideoError::CodecUnavailable(format!(
                    "libavcodec encoder '{encoder_name}' not present in this ffmpeg build"
                )));
            }

            // 4. Filter graph: DRM-PRIME source → hwmap(→VAAPI) → scale_vaapi
            //    (RGB→NV12, BT.709) → buffersink emitting VAAPI frames.
            pipe.build_filter_graph(config, input_width, input_height)?;

            // 5. Encoder consumes the buffersink's VAAPI frames.
            let hw_frames = ff::av_buffersink_get_hw_frames_ctx(pipe.buffersink_ctx);
            if hw_frames.is_null() {
                return Err(VideoError::EncoderInit(
                    "dma-buf import: filter graph produced no VAAPI frames context".into(),
                ));
            }

            pipe.enc_ctx = ff::avcodec_alloc_context3(encoder);
            if pipe.enc_ctx.is_null() {
                return Err(VideoError::EncoderInit(
                    "avcodec_alloc_context3 failed".into(),
                ));
            }
            configure_encoder_context(pipe.enc_ctx, LavcBackend::Vaapi, codec, config, hw_frames);

            let ret = ff::avcodec_open2(pipe.enc_ctx, encoder, ptr::null_mut());
            if ret < 0 {
                return Err(VideoError::EncoderInit(format!(
                    "dma-buf import: avcodec_open2 failed: {}",
                    av_error_text(ret)
                )));
            }

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

    /// Build the DRM-PRIME → VAAPI filter graph. Unlike the SHM path this uses a
    /// hardware buffer source configured through `av_buffersrc_parameters_set`
    /// (a software `pix_fmt` string cannot express a hw_frames_ctx).
    unsafe fn build_filter_graph(
        &mut self,
        config: &EncoderConfig,
        input_width: u32,
        input_height: u32,
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

        // The buffer source's args carry the base video params; the hardware
        // frames context is attached afterwards via parameters_set.
        let src_args = format!(
            "video_size={}x{}:pix_fmt={}:time_base=1/{}:pixel_aspect=1/1",
            input_width,
            input_height,
            ff::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as c_int,
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
                "create DRM-PRIME buffer source failed: {}",
                av_error_text(ret)
            )));
        }

        // Attach the DRM hardware frames context so the source knows the frames
        // it receives are hardware (DRM-PRIME) surfaces.
        let params = ff::av_buffersrc_parameters_alloc();
        if params.is_null() {
            return Err(VideoError::EncoderInit(
                "av_buffersrc_parameters_alloc failed".into(),
            ));
        }
        (*params).format = ff::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as c_int;
        (*params).width = input_width as c_int;
        (*params).height = input_height as c_int;
        (*params).time_base = ff::AVRational {
            num: 1,
            den: config.fps.max(1) as c_int,
        };
        (*params).hw_frames_ctx = ff::av_buffer_ref(self.drm_frames_ctx);
        let ret = ff::av_buffersrc_parameters_set(self.buffersrc_ctx, params);
        // parameters_set makes its own reference; free our copy's fields + the
        // struct regardless of outcome.
        if !(*params).hw_frames_ctx.is_null() {
            ff::av_buffer_unref(&mut (*params).hw_frames_ctx);
        }
        ff::av_free(params as *mut c_void);
        if ret < 0 {
            return Err(VideoError::EncoderInit(format!(
                "av_buffersrc_parameters_set failed: {}",
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

        // hwmap derives a VAAPI device from the input DRM frames and maps each
        // surface directly (zero-copy); scale_vaapi then does the RGB→NV12
        // conversion on the GPU under BT.709 limited range (C1).
        let (out_w, out_h) = (config.width, config.height);
        let filter_desc = format!(
            "hwmap=derive_device=vaapi:mode=direct,scale_vaapi=w={out_w}:h={out_h}:format=nv12:out_color_matrix=bt709:out_range=limited"
        );

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
            cstr(&filter_desc).as_ptr(),
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

        // The VAAPI device flows into the graph via the DRM frames context on
        // the buffer source (hwmap derives it), so no per-filter device is set.
        let ret = ff::avfilter_graph_config(self.filter_graph, ptr::null_mut());
        if ret < 0 {
            return Err(VideoError::EncoderInit(format!(
                "dma-buf import: avfilter_graph_config failed: {}",
                av_error_text(ret)
            )));
        }
        Ok(())
    }

    fn encode_frame(
        &mut self,
        pts: i64,
        desc: DmaBufDescriptor,
        force_keyframe: bool,
        codec: VideoCodec,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        unsafe {
            // Reset the reusable source frame and populate it as a DRM-PRIME
            // hardware frame wrapping the imported dma-buf.
            ff::av_frame_unref(self.src_frame);
            let drm_buf = build_drm_prime_buffer(&desc)?;
            let src = self.src_frame;
            (*src).format = ff::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as c_int;
            (*src).width = desc.width as c_int;
            (*src).height = desc.height as c_int;
            (*src).pts = pts;
            // data[0] points at the AVDRMFrameDescriptor; buf[0] owns it (and,
            // via its free callback, the fds). hw_frames_ctx tags it DRM.
            (*src).data[0] = (*drm_buf).data;
            (*src).buf[0] = drm_buf;
            (*src).hw_frames_ctx = ff::av_buffer_ref(self.drm_frames_ctx);
            if (*src).hw_frames_ctx.is_null() {
                ff::av_frame_unref(self.src_frame);
                return Err(VideoError::EncodeFailed(
                    "av_buffer_ref(drm_frames_ctx) failed".into(),
                ));
            }
            apply_keyframe_request(src, force_keyframe);

            // flags=0: the graph takes ownership of the frame's references
            // (the dma-buf stays alive through hwmap + encode; its fds close
            // when the mapped VAAPI surface is finally released).
            let ret = ff::av_buffersrc_add_frame_flags(self.buffersrc_ctx, src, 0);
            if ret < 0 {
                ff::av_frame_unref(self.src_frame);
                return Err(VideoError::EncodeFailed(format!(
                    "av_buffersrc_add_frame (dma-buf) failed: {}",
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
                        "av_buffersink_get_frame (dma-buf) failed: {}",
                        av_error_text(ret)
                    )));
                }
                apply_keyframe_request(self.filt_frame, force_keyframe);
                (*self.filt_frame).pts = pts;
                let send = self.send_frame_and_drain(self.filt_frame, codec, &mut frames);
                ff::av_frame_unref(self.filt_frame);
                send?;
            }
            Ok(frames)
        }
    }

    unsafe fn send_frame_and_drain(
        &mut self,
        frame: *mut ff::AVFrame,
        codec: VideoCodec,
        out: &mut Vec<EncodedFrame>,
    ) -> Result<(), VideoError> {
        let ret = ff::avcodec_send_frame(self.enc_ctx, frame);
        if ret < 0 && ret != ff::AVERROR_EOF {
            return Err(VideoError::EncodeFailed(format!(
                "avcodec_send_frame (dma-buf) failed: {}",
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
                    "avcodec_receive_packet (dma-buf) failed: {}",
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
            let _ = ff::av_buffersrc_add_frame_flags(self.buffersrc_ctx, ptr::null_mut(), 0);
            loop {
                let ret = ff::av_buffersink_get_frame(self.buffersink_ctx, self.filt_frame);
                if ret == AVERROR_EAGAIN || ret == ff::AVERROR_EOF {
                    break;
                }
                if ret < 0 {
                    return Err(VideoError::EncodeFailed(format!(
                        "flush: av_buffersink_get_frame (dma-buf) failed: {}",
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

impl Drop for DmaBufPipeline {
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
                ff::avfilter_graph_free(&mut self.filter_graph);
            }
            if !self.drm_frames_ctx.is_null() {
                ff::av_buffer_unref(&mut self.drm_frames_ctx);
            }
            if !self.drm_device_ctx.is_null() {
                ff::av_buffer_unref(&mut self.drm_device_ctx);
            }
        }
    }
}

// ── Free functions ───────────────────────────────────────────────────

/// Create the DRM hardware device the dma-bufs are imported through.
unsafe fn create_drm_device() -> Result<*mut ff::AVBufferRef, VideoError> {
    let mut device: *mut ff::AVBufferRef = ptr::null_mut();
    let device_str = vaapi_device_cstring();
    let device_ptr = device_str.as_ref().map_or(ptr::null(), |c| c.as_ptr());
    let ret = ff::av_hwdevice_ctx_create(
        &mut device,
        ff::AVHWDeviceType::AV_HWDEVICE_TYPE_DRM,
        device_ptr,
        ptr::null_mut(),
        0,
    );
    if ret < 0 {
        return Err(VideoError::EncoderInit(format!(
            "DRM hwdevice create failed: {}",
            av_error_text(ret)
        )));
    }
    Ok(device)
}

/// Allocate + init a DRM `AVHWFramesContext` describing the imported surfaces.
/// `initial_pool_size = 0` because the backing memory is the caller's dma-buf,
/// not a pool ffmpeg allocates.
unsafe fn create_drm_frames_ctx(
    drm_device_ctx: *mut ff::AVBufferRef,
    sw_fmt: ff::AVPixelFormat,
    width: u32,
    height: u32,
) -> Result<*mut ff::AVBufferRef, VideoError> {
    let frames_ref = ff::av_hwframe_ctx_alloc(drm_device_ctx);
    if frames_ref.is_null() {
        return Err(VideoError::EncoderInit(
            "av_hwframe_ctx_alloc(DRM) failed".into(),
        ));
    }
    let frames_ctx = (*frames_ref).data as *mut ff::AVHWFramesContext;
    (*frames_ctx).format = ff::AVPixelFormat::AV_PIX_FMT_DRM_PRIME;
    (*frames_ctx).sw_format = sw_fmt;
    (*frames_ctx).width = width as c_int;
    (*frames_ctx).height = height as c_int;
    (*frames_ctx).initial_pool_size = 0;
    let ret = ff::av_hwframe_ctx_init(frames_ref);
    if ret < 0 {
        let mut frames_ref = frames_ref;
        ff::av_buffer_unref(&mut frames_ref);
        return Err(VideoError::EncoderInit(format!(
            "av_hwframe_ctx_init(DRM) failed: {}",
            av_error_text(ret)
        )));
    }
    Ok(frames_ref)
}

/// Build an `AVBufferRef` owning a heap `AVDRMFrameDescriptor` populated from
/// `desc`. The returned buffer's `data` is the descriptor pointer (what the
/// AVFrame's `data[0]` must point at). Its free callback closes every fd and
/// frees the descriptor, so ownership of the fds transfers into the frame.
unsafe fn build_drm_prime_buffer(
    desc: &DmaBufDescriptor,
) -> Result<*mut ff::AVBufferRef, VideoError> {
    let size = std::mem::size_of::<ff::AVDRMFrameDescriptor>();
    let raw = ff::av_mallocz(size);
    if raw.is_null() {
        // The fds have not been placed in a descriptor yet, so the AVBuffer free
        // callback will never own them — close them here so this OOM path (the
        // only return before ownership transfers) does not leak fds.
        desc.close_fds();
        return Err(VideoError::EncodeFailed(
            "av_mallocz(AVDRMFrameDescriptor) failed".into(),
        ));
    }
    let drm = raw as *mut ff::AVDRMFrameDescriptor;

    (*drm).nb_objects = desc.objects.len() as c_int;
    for (i, obj) in desc.objects.iter().enumerate() {
        (*drm).objects[i].fd = obj.fd;
        (*drm).objects[i].size = obj.size;
        (*drm).objects[i].format_modifier = obj.modifier;
    }

    // A single layer holding every plane (the screen-capture RGB case; NV12 with
    // separate objects still maps as one layer with two planes).
    (*drm).nb_layers = 1;
    (*drm).layers[0].format = desc.drm_fourcc;
    (*drm).layers[0].nb_planes = desc.planes.len() as c_int;
    for (i, plane) in desc.planes.iter().enumerate() {
        (*drm).layers[0].planes[i].object_index = plane.object_index as c_int;
        (*drm).layers[0].planes[i].offset = plane.offset as isize;
        (*drm).layers[0].planes[i].pitch = plane.pitch as isize;
    }

    let buf = ff::av_buffer_create(
        raw as *mut u8,
        size,
        Some(free_drm_descriptor),
        ptr::null_mut(),
        0,
    );
    if buf.is_null() {
        // av_buffer_create only fails on OOM; close the fds we would have owned
        // and free the descriptor so nothing leaks.
        free_drm_descriptor(ptr::null_mut(), raw as *mut u8);
        return Err(VideoError::EncodeFailed(
            "av_buffer_create(AVDRMFrameDescriptor) failed".into(),
        ));
    }
    Ok(buf)
}

/// AVBuffer free callback: close every dma-buf fd the descriptor owns, then free
/// the descriptor. Runs when the last reference to the imported frame (through
/// the mapped VAAPI surface) is dropped — i.e. after the encode consumes it.
unsafe extern "C" fn free_drm_descriptor(_opaque: *mut c_void, data: *mut u8) {
    if data.is_null() {
        return;
    }
    let drm = data as *mut ff::AVDRMFrameDescriptor;
    let n = (*drm).nb_objects.clamp(0, 4) as usize;
    for i in 0..n {
        let fd = (*drm).objects[i].fd;
        if fd >= 0 {
            // Transfer into an OwnedFd whose Drop closes it exactly once.
            drop(OwnedFd::from_raw_fd(fd));
        }
    }
    ff::av_free(data as *mut c_void);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fourcc_values_match_drm_headers() {
        // Spot-check against the canonical little-endian ASCII packing.
        assert_eq!(DRM_FORMAT_XRGB8888, 0x3432_5258);
        assert_eq!(DRM_FORMAT_ARGB8888, 0x3432_5241);
    }

    #[test]
    fn fourcc_maps_to_expected_sw_format() {
        assert_eq!(
            drm_fourcc_to_sw_pix_fmt(DRM_FORMAT_XRGB8888),
            Some(ff::AVPixelFormat::AV_PIX_FMT_BGR0)
        );
        assert_eq!(
            drm_fourcc_to_sw_pix_fmt(DRM_FORMAT_ABGR8888),
            Some(ff::AVPixelFormat::AV_PIX_FMT_RGBA)
        );
        assert_eq!(drm_fourcc_to_sw_pix_fmt(0), None);
    }

    #[test]
    fn descriptor_rejects_invalid_modifier() {
        let desc = DmaBufDescriptor {
            width: 1920,
            height: 1080,
            drm_fourcc: DRM_FORMAT_XRGB8888,
            objects: vec![DmaBufObject {
                fd: 3,
                size: 1920 * 1080 * 4,
                modifier: DRM_FORMAT_MOD_INVALID,
            }],
            planes: vec![DmaBufPlane {
                object_index: 0,
                offset: 0,
                pitch: 1920 * 4,
            }],
        };
        assert!(desc.validate(1920, 1080).is_err());
    }

    #[test]
    fn descriptor_rejects_dimension_change() {
        let desc = DmaBufDescriptor {
            width: 1280,
            height: 720,
            drm_fourcc: DRM_FORMAT_XRGB8888,
            objects: vec![DmaBufObject {
                fd: 3,
                size: 1280 * 720 * 4,
                modifier: DRM_FORMAT_MOD_LINEAR,
            }],
            planes: vec![DmaBufPlane {
                object_index: 0,
                offset: 0,
                pitch: 1280 * 4,
            }],
        };
        // Graph built for 1920x1080; a 1280x720 frame is a hard error.
        assert!(desc.validate(1920, 1080).is_err());
        assert!(desc.validate(1280, 720).is_ok());
    }
}
