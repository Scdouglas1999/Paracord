//! In-process video decoder ([`LavcDecoder`]).
//!
//! Decodes H.264 (Annex-B), AV1 (OBU temporal units) and VP9 into I420 frames.
//! Hardware decode (NVDEC via CUDA, then VAAPI) is preferred and chosen once at
//! construction; libavcodec's own LGPL native decoders are the software floor
//! (native *decoders* are LGPL, so this stays LGPL-clean). Hardware frames are
//! downloaded and converted to I420 with a cached libswscale context.

use super::{av_error_text, cstr, AVERROR_EAGAIN};
use crate::video::decoder::{DecodeOutput, VideoDecoder};
#[cfg(all(unix, not(target_os = "macos")))]
use crate::video::handle::{CudaFrame, DmaBufFrame};
use crate::video::{
    ColorSpace, DecodedFrame, DecodedFrameHandle, DecoderConfig, EncodedFrame, PixelFormat,
    VideoCodec, VideoError,
};
use ffmpeg_sys_next as ff;
use std::ffi::c_int;
use std::ptr;

/// Largest decoded frame dimension (width or height) we will accept — the same
/// 8K bound the VP9 decoder uses. `width`/`height` come from a remote,
/// untrusted bitstream, so this caps a crafted-header DoS allocation before any
/// plane buffer is sized.
const MAX_DECODE_DIMENSION: u32 = 8192;
/// Largest decoded pixel count (8K UHD ≈ 33.2M pixels).
const MAX_DECODE_PIXELS: u32 = 7680 * 4320;

/// `SWS_BILINEAR` from libswscale (the algorithm is irrelevant for the
/// same-resolution NV12→I420 reformat, but a valid flag is required).
const SWS_BILINEAR: c_int = 2;

/// Slack allocated past the exact I420 frame size for the swscale destination.
///
/// libswscale's vectorized output kernels may write a partial SIMD register
/// past the last requested byte of the final row (this is why `av_image_alloc`
/// pads its allocations). The buffer is truncated back to the exact frame size
/// before it is returned, so this is invisible to consumers; it exists purely so
/// such a tail write can never land outside the allocation.
const SWS_DST_TAIL_PADDING: usize = 64;

/// Which decode path was selected at construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecodeBackend {
    Cuda,
    Vaapi,
    Software,
}

/// A hardware-preferred video decoder built on in-process libavcodec.
pub struct LavcDecoder {
    config: DecoderConfig,
    backend: DecodeBackend,
    /// Where decoded frames are placed, fixed at construction (spec §3.2). In
    /// [`DecodeOutput::Gpu`] mode the decode keeps the frame GPU-resident; in
    /// [`DecodeOutput::Cpu`] mode it downloads to I420 (unchanged behaviour).
    output: DecodeOutput,
    backend_name: &'static str,
    dec_ctx: *mut ff::AVCodecContext,
    hw_device_ctx: *mut ff::AVBufferRef,
    /// The hardware pixel format the decoder emits (CUDA/VAAPI), read by the
    /// `get_format` callback via `AVCodecContext::opaque`. Boxed so its address
    /// is stable across moves of `LavcDecoder`.
    hw_pix_fmt: Box<ff::AVPixelFormat>,
    /// Reusable software frame that `av_hwframe_transfer_data` downloads into.
    sw_frame: *mut ff::AVFrame,
    dec_frame: *mut ff::AVFrame,
    packet: *mut ff::AVPacket,
    sws: *mut ff::SwsContext,
    needs_keyframe: bool,
}

// Safety: all raw pointers are accessed only through `&mut self`.
unsafe impl Send for LavcDecoder {}

impl LavcDecoder {
    /// Create a decoder for `codec` with CPU (I420) output — the back-compatible
    /// constructor. Equivalent to `new_with_output(codec, config,
    /// DecodeOutput::Cpu)`.
    pub fn new(codec: VideoCodec, config: DecoderConfig) -> Result<Self, VideoError> {
        Self::new_with_output(codec, config, DecodeOutput::Cpu)
    }

    /// Create a decoder for `codec`, selecting the hardware path (CUDA → VAAPI)
    /// if the decoder advertises it and the device can be created; otherwise
    /// the software decoder. The choice is fixed for the decoder's life.
    ///
    /// `output` fixes where decoded frames land (spec §3.2). In
    /// [`DecodeOutput::Gpu`] mode a hardware backend is **required**: if only the
    /// software decoder is available, construction fails loudly rather than
    /// silently producing CPU frames — the route selector is responsible for
    /// choosing the CPU floor (tier-2, §3.4) up front instead.
    pub fn new_with_output(
        codec: VideoCodec,
        config: DecoderConfig,
        output: DecodeOutput,
    ) -> Result<Self, VideoError> {
        let decoder_name = match codec {
            VideoCodec::H264 => "h264",
            VideoCodec::Av1 => "av1",
            VideoCodec::Vp9 => "vp9",
        };

        unsafe {
            let decoder = ff::avcodec_find_decoder_by_name(cstr(decoder_name).as_ptr());
            if decoder.is_null() {
                return Err(VideoError::DecoderInit(format!(
                    "libavcodec decoder '{decoder_name}' not present in this ffmpeg build"
                )));
            }

            // Probe hardware decode: find an advertised hw config and create its
            // device. NVDEC (CUDA) first, then VAAPI, then software.
            let (backend, hw_device, hw_pix) = select_decode_backend(decoder);

            // GPU output demands a hardware backend on a platform we can export
            // from. This decision is made once here; a later export failure is a
            // decode error, never a fallback (spec §3.2, §3.7).
            if matches!(output, DecodeOutput::Gpu) {
                let gpu_supported =
                    cfg!(all(unix, not(target_os = "macos"))) && backend != DecodeBackend::Software;
                if !gpu_supported {
                    if !hw_device.is_null() {
                        ff::av_buffer_unref(&mut { hw_device });
                    }
                    return Err(VideoError::DecoderInit(format!(
                        "GPU decode output requested for '{decoder_name}' but no exportable hardware backend is available (backend={backend:?})"
                    )));
                }
            }

            let dec_ctx = ff::avcodec_alloc_context3(decoder);
            if dec_ctx.is_null() {
                if !hw_device.is_null() {
                    ff::av_buffer_unref(&mut { hw_device });
                }
                return Err(VideoError::DecoderInit(
                    "avcodec_alloc_context3 failed".into(),
                ));
            }

            let hw_pix_fmt = Box::new(hw_pix);
            if backend != DecodeBackend::Software {
                (*dec_ctx).hw_device_ctx = ff::av_buffer_ref(hw_device);
                // Point the get_format callback at our chosen hw format. The
                // Box outlives dec_ctx (freed after it in Drop) and its address
                // is stable across moves of the returned struct.
                (*dec_ctx).opaque = (&*hw_pix_fmt as *const ff::AVPixelFormat) as *mut _;
                (*dec_ctx).get_format = Some(get_hw_format);
            }

            let ret = ff::avcodec_open2(dec_ctx, decoder, ptr::null_mut());
            if ret < 0 {
                let mut dec_ctx = dec_ctx;
                ff::avcodec_free_context(&mut dec_ctx);
                let mut hw_device = hw_device;
                if !hw_device.is_null() {
                    ff::av_buffer_unref(&mut hw_device);
                }
                return Err(VideoError::DecoderInit(format!(
                    "avcodec_open2({decoder_name}) failed: {}",
                    av_error_text(ret)
                )));
            }

            let sw_frame = ff::av_frame_alloc();
            let dec_frame = ff::av_frame_alloc();
            let packet = ff::av_packet_alloc();
            if sw_frame.is_null() || dec_frame.is_null() || packet.is_null() {
                let mut dec_ctx = dec_ctx;
                ff::avcodec_free_context(&mut dec_ctx);
                let mut hw_device = hw_device;
                if !hw_device.is_null() {
                    ff::av_buffer_unref(&mut hw_device);
                }
                return Err(VideoError::DecoderInit(
                    "av_frame/packet_alloc failed".into(),
                ));
            }

            let backend_name = match (codec, backend) {
                (_, DecodeBackend::Cuda) => "lavc-nvdec",
                (_, DecodeBackend::Vaapi) => "lavc-vaapi-decode",
                (VideoCodec::H264, DecodeBackend::Software) => "lavc-sw-h264",
                (VideoCodec::Av1, DecodeBackend::Software) => "lavc-sw-av1",
                (VideoCodec::Vp9, DecodeBackend::Software) => "lavc-sw-vp9",
            };

            Ok(Self {
                config,
                backend,
                output,
                backend_name,
                dec_ctx,
                hw_device_ctx: hw_device,
                hw_pix_fmt,
                sw_frame,
                dec_frame,
                packet,
                sws: ptr::null_mut(),
                needs_keyframe: true,
            })
        }
    }

    /// Diagnostic name of the selected decode path.
    pub fn backend_name(&self) -> &'static str {
        self.backend_name
    }

    /// Whether this decoder uses hardware acceleration.
    pub fn is_hardware_accelerated(&self) -> bool {
        self.backend != DecodeBackend::Software
    }

    /// Convert one decoded frame (`src`, either a downloaded software frame or a
    /// native software decode) to a tightly-packed I420 buffer via swscale.
    unsafe fn frame_to_i420(
        &mut self,
        src: *mut ff::AVFrame,
        pts: i64,
    ) -> Result<DecodedFrame, VideoError> {
        let width = (*src).width as u32;
        let height = (*src).height as u32;
        self.bound_decode_resolution(width, height)?;
        // Carry the source bitstream's signaled matrix through the plane repack
        // (NV12/YUV→I420 leaves the matrix unchanged) so the consumer converts
        // to RGB with the right coefficients (contract C1).
        let colorspace = map_av_colorspace((*src).colorspace);

        // I420 has exactly half-resolution chroma planes, so the repack target
        // must be even in BOTH axes. `width`/`height` come from a remote,
        // untrusted bitstream and are NOT guaranteed even: H.264 conveys its
        // display size via `frame_crop_*_offset` and libavcodec applies the
        // crop, so a peer can legally publish e.g. 1920x1079. For
        // AV_PIX_FMT_YUV420P swscale writes ceil(h/2) chroma rows of ceil(w/2)
        // bytes; sizing the destination with a truncating `w/2 * h/2` while
        // handing swscale the full source height let it write up to a whole
        // chroma row (4096 bytes at the 8K cap) of attacker-controlled data past
        // the end of the heap allocation.
        //
        // Clamping the swscale *destination* to even makes the allocation, the
        // strides and what swscale actually writes agree exactly, and preserves
        // the project-wide invariant that a decoded I420 frame is even-sized —
        // `PixelFormat::frame_size` and every downstream consumer compute chroma
        // as a truncating `w/2 * h/2`. In the overwhelmingly common even case
        // `out_*` equals the source, so this stays a pure format conversion.
        let out_width = width & !1;
        let out_height = height & !1;
        if out_width == 0 || out_height == 0 {
            return Err(VideoError::DecodeFailed(format!(
                "decoded frame is too small to repack as I420: {width}x{height}"
            )));
        }

        let src_fmt: ff::AVPixelFormat =
            std::mem::transmute::<c_int, ff::AVPixelFormat>((*src).format);
        self.sws = ff::sws_getCachedContext(
            self.sws,
            width as c_int,
            height as c_int,
            src_fmt,
            out_width as c_int,
            out_height as c_int,
            ff::AVPixelFormat::AV_PIX_FMT_YUV420P,
            SWS_BILINEAR,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        );
        if self.sws.is_null() {
            return Err(VideoError::DecodeFailed(
                "sws_getCachedContext failed for I420 conversion".into(),
            ));
        }

        let w = out_width as usize;
        let h = out_height as usize;
        let y_size = w * h;
        let uv_w = w / 2;
        let uv_h = h / 2;
        let uv_size = uv_w * uv_h;
        let frame_size = y_size + 2 * uv_size;
        debug_assert_eq!(
            frame_size,
            PixelFormat::I420.frame_size(out_width, out_height)
        );
        let mut out = vec![0u8; frame_size + SWS_DST_TAIL_PADDING];
        let base = out.as_mut_ptr();
        // Safety: `base` owns at least `frame_size + SWS_DST_TAIL_PADDING`
        // bytes, and the three plane offsets (0, y_size, y_size + uv_size) are
        // all strictly below `frame_size`, so every derived pointer is in
        // bounds. Each plane is exactly `stride * rows` bytes with `stride`
        // equal to that plane's width, and the swscale destination is
        // `out_width` x `out_height` with both even — so the chroma planes are
        // exactly uv_w x uv_h, which is what swscale writes for YUV420P at that
        // destination size (ceil is exact on even inputs). The tail padding
        // absorbs any partial-vector write past the final row from libswscale's
        // SIMD kernels; it is truncated away below and never observed.
        let dst_data: [*mut u8; 4] = [
            base,
            base.add(y_size),
            base.add(y_size + uv_size),
            ptr::null_mut(),
        ];
        let dst_stride: [c_int; 4] = [w as c_int, uv_w as c_int, uv_w as c_int, 0];
        let scaled = ff::sws_scale(
            self.sws,
            (*src).data.as_ptr() as *const *const u8,
            (*src).linesize.as_ptr(),
            0,
            height as c_int,
            dst_data.as_ptr(),
            dst_stride.as_ptr(),
        );
        if scaled < 0 {
            return Err(VideoError::DecodeFailed(format!(
                "sws_scale failed: {}",
                av_error_text(scaled)
            )));
        }
        out.truncate(frame_size);

        Ok(DecodedFrame {
            data: out,
            pixel_format: PixelFormat::I420,
            width: out_width,
            height: out_height,
            pts,
            colorspace,
        })
    }

    /// Reject implausibly large decoded resolutions before any plane buffer is
    /// allocated, capping against the resolution the peer negotiated when the
    /// track was published (when known) rather than only the global 8K ceiling.
    fn bound_decode_resolution(&self, w: u32, h: u32) -> Result<(), VideoError> {
        bound_decode_resolution_against(w, h, self.config.max_dimensions)
    }

    /// Decode into GPU-resident handles (spec §3.2 G2). Sends `frame`, then for
    /// each received hardware frame exports a [`DecodedFrameHandle`] without ever
    /// touching the CPU: CUDA frames are retained (`av_frame_clone`, no
    /// `av_hwframe_transfer_data`); VAAPI frames are exported to DRM-PRIME
    /// dma-bufs. Only reached when `self.output == DecodeOutput::Gpu`, which
    /// construction guarantees a hardware backend for.
    #[cfg(all(unix, not(target_os = "macos")))]
    fn decode_gpu(&mut self, frame: &EncodedFrame) -> Result<Vec<DecodedFrameHandle>, VideoError> {
        if self.needs_keyframe && !frame.is_keyframe {
            return Err(VideoError::KeyframeRequired);
        }
        if frame.is_keyframe {
            self.needs_keyframe = false;
        }

        unsafe {
            let pkt = self.packet;
            (*pkt).data = frame.data.as_ptr() as *mut u8;
            (*pkt).size = frame.data.len() as c_int;
            (*pkt).flags = if frame.is_keyframe {
                ff::AV_PKT_FLAG_KEY
            } else {
                0
            };

            let ret = ff::avcodec_send_packet(self.dec_ctx, pkt);
            (*pkt).data = ptr::null_mut();
            (*pkt).size = 0;
            if ret < 0 && ret != AVERROR_EAGAIN {
                self.needs_keyframe = true;
                return Err(VideoError::DecodeFailed(format!(
                    "avcodec_send_packet failed: {}",
                    av_error_text(ret)
                )));
            }

            let hw_fmt = *self.hw_pix_fmt as c_int;
            let mut handles = Vec::new();
            loop {
                let ret = ff::avcodec_receive_frame(self.dec_ctx, self.dec_frame);
                if ret == AVERROR_EAGAIN || ret == ff::AVERROR_EOF {
                    break;
                }
                if ret < 0 {
                    self.needs_keyframe = true;
                    return Err(VideoError::DecodeFailed(format!(
                        "avcodec_receive_frame failed: {}",
                        av_error_text(ret)
                    )));
                }

                // GPU export requires a real hardware frame. A software frame
                // here means the chosen backend degraded — a hard error, never a
                // silent CPU fallback (spec §3.7).
                if (*self.dec_frame).format != hw_fmt {
                    ff::av_frame_unref(self.dec_frame);
                    self.needs_keyframe = true;
                    return Err(VideoError::DecodeFailed(
                        "GPU decode produced a non-hardware frame; cannot export a GPU-resident handle".into(),
                    ));
                }

                let width = (*self.dec_frame).width as u32;
                let height = (*self.dec_frame).height as u32;
                if let Err(e) = self.bound_decode_resolution(width, height) {
                    ff::av_frame_unref(self.dec_frame);
                    self.needs_keyframe = true;
                    return Err(e);
                }
                let colorspace = map_av_colorspace((*self.dec_frame).colorspace);

                // Retain/export from the decoder's frame; both paths clone it, so
                // `dec_frame` is unref'd afterwards regardless. On failure unref
                // first so the working frame never leaks.
                let handle = match self.backend {
                    DecodeBackend::Cuda => match CudaFrame::retain(self.dec_frame, colorspace) {
                        Ok(cuda) => DecodedFrameHandle::CudaNv12(cuda),
                        Err(e) => {
                            ff::av_frame_unref(self.dec_frame);
                            self.needs_keyframe = true;
                            return Err(e);
                        }
                    },
                    DecodeBackend::Vaapi => {
                        match DmaBufFrame::from_vaapi_export(self.dec_frame, colorspace) {
                            Ok(dmabuf) => DecodedFrameHandle::DmaBufNv12(dmabuf),
                            Err(e) => {
                                ff::av_frame_unref(self.dec_frame);
                                self.needs_keyframe = true;
                                return Err(e);
                            }
                        }
                    }
                    // Rejected at construction; defensive only.
                    DecodeBackend::Software => {
                        ff::av_frame_unref(self.dec_frame);
                        return Err(VideoError::DecodeFailed(
                            "GPU decode output on a software backend (should be unreachable)"
                                .into(),
                        ));
                    }
                };

                ff::av_frame_unref(self.dec_frame);
                handles.push(handle);
            }
            Ok(handles)
        }
    }

    /// Platforms without an exportable GPU backend never construct a
    /// [`DecodeOutput::Gpu`] decoder (rejected in `new_with_output`), so this is
    /// unreachable; it exists only so `decode_to_handles` compiles everywhere the
    /// `lavc` feature is enabled.
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    fn decode_gpu(&mut self, _frame: &EncodedFrame) -> Result<Vec<DecodedFrameHandle>, VideoError> {
        Err(VideoError::DecodeFailed(
            "GPU decode output is unsupported on this platform".into(),
        ))
    }
}

impl VideoDecoder for LavcDecoder {
    fn decode(&mut self, frame: &EncodedFrame) -> Result<Vec<DecodedFrame>, VideoError> {
        // Same recovery contract as the VP9 decoder: refuse inter frames until a
        // keyframe re-primes reference state so the pipeline requests one.
        if self.needs_keyframe && !frame.is_keyframe {
            return Err(VideoError::KeyframeRequired);
        }
        if frame.is_keyframe {
            self.needs_keyframe = false;
        }

        unsafe {
            let pkt = self.packet;
            (*pkt).data = frame.data.as_ptr() as *mut u8;
            (*pkt).size = frame.data.len() as c_int;
            (*pkt).flags = if frame.is_keyframe {
                ff::AV_PKT_FLAG_KEY
            } else {
                0
            };

            let ret = ff::avcodec_send_packet(self.dec_ctx, pkt);
            // Reset the borrowed view so the reusable packet never dangles.
            (*pkt).data = ptr::null_mut();
            (*pkt).size = 0;
            if ret < 0 && ret != AVERROR_EAGAIN {
                self.needs_keyframe = true;
                return Err(VideoError::DecodeFailed(format!(
                    "avcodec_send_packet failed: {}",
                    av_error_text(ret)
                )));
            }

            let hw_fmt = *self.hw_pix_fmt as c_int;
            let mut decoded = Vec::new();
            loop {
                let ret = ff::avcodec_receive_frame(self.dec_ctx, self.dec_frame);
                if ret == AVERROR_EAGAIN || ret == ff::AVERROR_EOF {
                    break;
                }
                if ret < 0 {
                    self.needs_keyframe = true;
                    return Err(VideoError::DecodeFailed(format!(
                        "avcodec_receive_frame failed: {}",
                        av_error_text(ret)
                    )));
                }

                // Download hardware frames to system memory, then convert.
                let src = if self.backend != DecodeBackend::Software
                    && (*self.dec_frame).format == hw_fmt
                {
                    ff::av_frame_unref(self.sw_frame);
                    let ret = ff::av_hwframe_transfer_data(self.sw_frame, self.dec_frame, 0);
                    if ret < 0 {
                        ff::av_frame_unref(self.dec_frame);
                        self.needs_keyframe = true;
                        return Err(VideoError::DecodeFailed(format!(
                            "av_hwframe_transfer_data failed: {}",
                            av_error_text(ret)
                        )));
                    }
                    self.sw_frame
                } else {
                    self.dec_frame
                };

                let result = self.frame_to_i420(src, frame.pts);
                ff::av_frame_unref(self.dec_frame);
                if src == self.sw_frame {
                    ff::av_frame_unref(self.sw_frame);
                }
                decoded.push(result?);
            }
            Ok(decoded)
        }
    }

    fn decode_to_handles(
        &mut self,
        frame: &EncodedFrame,
    ) -> Result<Vec<DecodedFrameHandle>, VideoError> {
        match self.output {
            // CPU mode is the default trait behaviour and also the §3.4 tier-2
            // floor (hardware decode → download → I420).
            DecodeOutput::Cpu => Ok(self
                .decode(frame)?
                .into_iter()
                .map(DecodedFrameHandle::cpu_i420_from)
                .collect()),
            DecodeOutput::Gpu => self.decode_gpu(frame),
        }
    }

    fn needs_keyframe(&self) -> bool {
        self.needs_keyframe
    }

    fn clear_keyframe_request(&mut self) {
        self.needs_keyframe = false;
    }

    fn reset(&mut self) -> Result<(), VideoError> {
        unsafe {
            ff::avcodec_flush_buffers(self.dec_ctx);
        }
        self.needs_keyframe = true;
        Ok(())
    }

    fn config(&self) -> &DecoderConfig {
        &self.config
    }
}

impl Drop for LavcDecoder {
    fn drop(&mut self) {
        unsafe {
            if !self.packet.is_null() {
                ff::av_packet_free(&mut self.packet);
            }
            if !self.dec_frame.is_null() {
                ff::av_frame_free(&mut self.dec_frame);
            }
            if !self.sw_frame.is_null() {
                ff::av_frame_free(&mut self.sw_frame);
            }
            if !self.sws.is_null() {
                ff::sws_freeContext(self.sws);
            }
            // Free the codec context before the device it references.
            if !self.dec_ctx.is_null() {
                ff::avcodec_free_context(&mut self.dec_ctx);
            }
            if !self.hw_device_ctx.is_null() {
                ff::av_buffer_unref(&mut self.hw_device_ctx);
            }
        }
    }
}

// ── Free functions ───────────────────────────────────────────────────

/// `get_format` callback: pick our chosen hardware pixel format from the
/// offered list. Returning `AV_PIX_FMT_NONE` when it is absent fails the decode
/// loudly rather than silently falling back to a different path — the chosen
/// backend was already validated at construction.
unsafe extern "C" fn get_hw_format(
    ctx: *mut ff::AVCodecContext,
    mut fmt: *const ff::AVPixelFormat,
) -> ff::AVPixelFormat {
    let want = *((*ctx).opaque as *const ff::AVPixelFormat);
    while *fmt != ff::AVPixelFormat::AV_PIX_FMT_NONE {
        if *fmt == want {
            return want;
        }
        fmt = fmt.add(1);
    }
    ff::AVPixelFormat::AV_PIX_FMT_NONE
}

/// Select the decode backend by scanning the decoder's advertised hardware
/// configs (CUDA first, then VAAPI) and creating the first device that works.
/// Returns `Software` with a null device if neither is available.
unsafe fn select_decode_backend(
    decoder: *const ff::AVCodec,
) -> (DecodeBackend, *mut ff::AVBufferRef, ff::AVPixelFormat) {
    for (backend, dev_type) in [
        (
            DecodeBackend::Cuda,
            ff::AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA,
        ),
        (
            DecodeBackend::Vaapi,
            ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
        ),
    ] {
        if let Some(hw_pix) = decoder_hw_pix_fmt(decoder, dev_type) {
            let mut device = ptr::null_mut();
            let device_str = if dev_type == ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI {
                std::env::var("PARACORD_VAAPI_DEVICE")
                    .ok()
                    .map(|p| cstr(&p))
            } else {
                None
            };
            let device_ptr = device_str.as_ref().map_or(ptr::null(), |c| c.as_ptr());
            let ret =
                ff::av_hwdevice_ctx_create(&mut device, dev_type, device_ptr, ptr::null_mut(), 0);
            if ret >= 0 && !device.is_null() {
                return (backend, device, hw_pix);
            }
        }
    }
    (
        DecodeBackend::Software,
        ptr::null_mut(),
        ff::AVPixelFormat::AV_PIX_FMT_NONE,
    )
}

/// The hardware output pixel format the decoder uses for `dev_type`, if it
/// advertises a hw-device-context config for that device type.
unsafe fn decoder_hw_pix_fmt(
    decoder: *const ff::AVCodec,
    dev_type: ff::AVHWDeviceType,
) -> Option<ff::AVPixelFormat> {
    let mut i = 0;
    loop {
        let cfg = ff::avcodec_get_hw_config(decoder, i);
        if cfg.is_null() {
            return None;
        }
        let methods = (*cfg).methods;
        if methods & (ff::AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX as c_int) != 0
            && (*cfg).device_type == dev_type
        {
            return Some((*cfg).pix_fmt);
        }
        i += 1;
    }
}

/// Map a libavcodec `AVColorSpace` to our [`ColorSpace`]. Unspecified or
/// unrecognized values fall back to the project default (BT.709); the two SD
/// matrices map to BT.601 so a genuinely 601 source is signaled honestly.
fn map_av_colorspace(cs: ff::AVColorSpace) -> ColorSpace {
    match cs {
        ff::AVColorSpace::AVCOL_SPC_BT470BG | ff::AVColorSpace::AVCOL_SPC_SMPTE170M => {
            ColorSpace::Bt601
        }
        _ => ColorSpace::Bt709,
    }
}

/// Reject implausibly large decoded resolutions before any plane buffer is
/// allocated. Uses checked arithmetic so `w * h` cannot overflow before it is
/// range-checked.
/// `negotiated` is the resolution the peer advertised for this track in
/// `TrackPublish`. When present it is the real cap (with the tolerance factor in
/// [`crate::video::negotiated_decode_ceiling`]): a peer that published a 320x180
/// layer has no business sending 8K frames, and the global ceiling alone lets a
/// few hundred bytes of bitstream expand into a ~50 MB plane allocation.
fn bound_decode_resolution_against(
    w: u32,
    h: u32,
    negotiated: Option<(u32, u32)>,
) -> Result<(), VideoError> {
    let (max_w, max_h, max_px) = crate::video::negotiated_decode_ceiling(
        negotiated,
        MAX_DECODE_DIMENSION,
        MAX_DECODE_PIXELS,
    );
    let ok = w > 0
        && h > 0
        && w <= max_w
        && h <= max_h
        && w.checked_mul(h).is_some_and(|px| px <= max_px);
    if ok {
        Ok(())
    } else {
        Err(VideoError::DecodeFailed(format!(
            "decoded frame resolution out of bounds: {w}x{h} (max {max_w}x{max_h})"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_bounds() {
        assert!(bound_decode_resolution_against(1920, 1080, None).is_ok());
        assert!(bound_decode_resolution_against(7680, 4320, None).is_ok());
        assert!(bound_decode_resolution_against(8193, 16, None).is_err());
        assert!(bound_decode_resolution_against(u32::MAX, u32::MAX, None).is_err());
        assert!(bound_decode_resolution_against(0, 16, None).is_err());
        assert!(bound_decode_resolution_against(16, 0, None).is_err());
    }

    #[test]
    fn negotiated_resolution_caps_decode() {
        // A peer that published a 320x180 layer cannot then send 4K frames.
        assert!(bound_decode_resolution_against(320, 180, Some((320, 180))).is_ok());
        assert!(bound_decode_resolution_against(3840, 2160, Some((320, 180))).is_err());
        // Modest overshoot (encoder alignment padding) stays acceptable.
        assert!(bound_decode_resolution_against(336, 192, Some((320, 180))).is_ok());
    }

    /// The odd-dimension repack is the memory-safety fix: an H.264 peer can
    /// legally signal an odd display height via `frame_crop_bottom_offset`, so
    /// the swscale destination must be clamped to even for the chroma
    /// allocation and the strides to agree with what swscale writes.
    #[test]
    fn odd_dimensions_clamp_to_an_exact_i420_buffer() {
        for (w, h) in [(1920u32, 1079u32), (1921, 1080), (1921, 1079), (641, 361)] {
            let out_w = w & !1;
            let out_h = h & !1;
            assert!(out_w > 0 && out_h > 0);
            assert_eq!(out_w % 2, 0);
            assert_eq!(out_h % 2, 0);

            let y = (out_w as usize) * (out_h as usize);
            let uv = (out_w as usize / 2) * (out_h as usize / 2);
            // The repack buffer must equal exactly what swscale writes for
            // YUV420P at the (even) destination size.
            assert_eq!(
                y + 2 * uv,
                PixelFormat::I420.frame_size(out_w, out_h),
                "{w}x{h} -> {out_w}x{out_h}"
            );

            // The pre-fix sizing used truncating halves of the ODD source while
            // swscale wrote ceil() halves — short by up to a full chroma row per
            // plane. That difference is the heap overflow.
            let buggy = (w as usize) * (h as usize) + 2 * ((w as usize) / 2) * ((h as usize) / 2);
            let actually_written = (w as usize) * (h as usize)
                + 2 * (w as usize).div_ceil(2) * (h as usize).div_ceil(2);
            assert!(
                buggy < actually_written,
                "odd {w}x{h} must under-size under the old formula"
            );
        }

        // A source with a dimension of 1 has no representable I420 form and is
        // rejected rather than silently producing a zero-sized plane.
        assert_eq!(1u32 & !1, 0);
    }
}
