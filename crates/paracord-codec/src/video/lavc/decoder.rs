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
        bound_decode_resolution(width, height)?;
        // Carry the source bitstream's signaled matrix through the plane repack
        // (NV12/YUV→I420 leaves the matrix unchanged) so the consumer converts
        // to RGB with the right coefficients (contract C1).
        let colorspace = map_av_colorspace((*src).colorspace);

        let src_fmt: ff::AVPixelFormat =
            std::mem::transmute::<c_int, ff::AVPixelFormat>((*src).format);
        self.sws = ff::sws_getCachedContext(
            self.sws,
            width as c_int,
            height as c_int,
            src_fmt,
            width as c_int,
            height as c_int,
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

        let w = width as usize;
        let h = height as usize;
        let y_size = w * h;
        let uv_w = w / 2;
        let uv_size = uv_w * (h / 2);
        let mut out = vec![0u8; y_size + 2 * uv_size];
        let base = out.as_mut_ptr();
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

        Ok(DecodedFrame {
            data: out,
            pixel_format: PixelFormat::I420,
            width,
            height,
            pts,
            colorspace,
        })
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
                if let Err(e) = bound_decode_resolution(width, height) {
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
fn bound_decode_resolution(w: u32, h: u32) -> Result<(), VideoError> {
    let ok = w <= MAX_DECODE_DIMENSION
        && h <= MAX_DECODE_DIMENSION
        && w.checked_mul(h).is_some_and(|px| px <= MAX_DECODE_PIXELS);
    if ok {
        Ok(())
    } else {
        Err(VideoError::DecodeFailed(format!(
            "decoded frame resolution out of bounds: {w}x{h}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_bounds() {
        assert!(bound_decode_resolution(1920, 1080).is_ok());
        assert!(bound_decode_resolution(7680, 4320).is_ok());
        assert!(bound_decode_resolution(8193, 16).is_err());
        assert!(bound_decode_resolution(u32::MAX, u32::MAX).is_err());
    }
}
