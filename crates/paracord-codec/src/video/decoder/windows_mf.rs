//! Windows Media Foundation decoders for H.264 and AV1 (CPU I420 output).
//!
//! The Windows desktop app draws every remote video on a Direct3D surface that
//! uploads CPU I420 (`native_render::windows`), so these decoders hand back
//! tightly packed I420 through the default `decode_to_handles`
//! ([`DecodedFrameHandle::CpuI420`](crate::video::DecodedFrameHandle)).
//!
//! # Which MFT, and why software output
//! - **H.264**: the in-box Microsoft H.264 decoder (`CLSID_MSH264DecoderMFT`,
//!   `msmpeg2vdec.dll`), created directly by CLSID. It is present on every
//!   Windows 10/11 SKU except the N editions without the Media Feature Pack, in
//!   which case construction fails with a [`VideoError::CodecUnavailable`] that
//!   names the cause.
//! - **AV1**: there is no in-box AV1 decoder. The first *synchronous, local*
//!   MFT that `MFTEnumEx(MFT_CATEGORY_VIDEO_DECODER)` reports for
//!   `MFVideoFormat_AV1` is used; on a stock system that is the decoder from the
//!   "AV1 Video Extension" (Microsoft Store). With none installed,
//!   [`create_decoder`](super::create_decoder) returns `CodecUnavailable` saying
//!   so, and the capability report says AV1 cannot be decoded here.
//!
//! Both decoders run **without a Direct3D device manager**, so they decode in
//! software into system memory. That is the deterministic choice: handing the
//! MFT a D3D11 manager makes it decode with DXVA when the GPU supports the
//! stream and silently in software when it does not, and the output would then
//! be a GPU texture that still has to be read back for the CPU-upload surface.
//! The capability report therefore keeps `decode_hardware: false` for both,
//! which is the truth. Hardware MFTs (asynchronous by contract) are not
//! enumerated at all.
//!
//! # Output format and color
//! The output type is negotiated by preference: I420 / IYUV first (the
//! surface's own layout), NV12 otherwise; nothing else is accepted. The
//! decoder's strided, possibly height-padded output (1920x1088 for 1080p
//! H.264) is cropped to the minimum display aperture and repacked into tight
//! I420 ([`super::bitstream::repack_to_i420`]). The YUV matrix is, in order:
//! what the bitstream's parameter set signals (H.264 VUI / AV1 `color_config`,
//! parsed here), else the output type's `MF_MT_YUV_MATRIX`, else BT.709, which
//! is what every Paracord encoder signals (contract C1). Range is assumed
//! limited (every Paracord encoder emits limited range).
//!
//! # Streaming semantics
//! - A fresh decoder (and one after [`reset`](VideoDecoder::reset) or a decode
//!   error) needs a keyframe; anything else is `KeyframeRequired`.
//! - The SPS / sequence header in every access unit is parsed *before* the
//!   bytes reach the MFT and refused when it exceeds
//!   [`DecoderConfig::max_dimensions`] (or the global 8K ceiling), so a crafted
//!   header cannot make the MFT allocate an 8K reference pool. The negotiated
//!   output type is checked again at every stream change.
//! - `MF_E_TRANSFORM_STREAM_CHANGE` renegotiates the output type in place and
//!   keeps pulling; `MF_E_TRANSFORM_NEED_MORE_INPUT` ends the pull. Nothing is
//!   drained on the hot path: `MF_LOW_LATENCY` is set so the decoder emits each
//!   picture as soon as it is decodable (Paracord's encoders never use
//!   B-frames, so there is no reorder delay to wait out).
//!
//! # Threading
//! The decode worker calls into the decoder from tokio's blocking pool, so
//! consecutive calls can land on different threads (always one at a time,
//! behind the pipeline's mutex). Both MFTs are free-threaded ("Both" model);
//! every entry point first joins the calling thread to the multithreaded
//! apartment (once per thread), which is what makes moving the transform
//! between threads sound.
//!
//! # Verification status
//! Compile-checked for `x86_64-pc-windows-gnu` from Linux; never run. The pure
//! parsing and repacking it relies on is unit tested on every platform.

use std::cell::Cell;
use std::mem::ManuallyDrop;
use std::ptr::null_mut;
use std::sync::OnceLock;

use windows::core::{Interface, GUID};
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::Media::MediaFoundation::{
    CLSID_MSH264DecoderMFT, IMF2DBuffer2, IMFActivate, IMFMediaBuffer, IMFMediaType, IMFSample,
    IMFTransform, MF2DBuffer_LockFlags_Read, MFCreateAlignedMemoryBuffer, MFCreateMediaType,
    MFCreateMemoryBuffer, MFCreateSample, MFMediaType_Video, MFOffset,
    MFSampleExtension_CleanPoint, MFStartup, MFTEnumEx, MFT_FRIENDLY_NAME_Attribute, MFVideoArea,
    MFVideoFormat_AV1, MFVideoFormat_H264, MFVideoFormat_I420, MFVideoFormat_IYUV,
    MFVideoFormat_NV12, MFVideoTransferMatrix_BT601, MFVideoTransferMatrix_BT709, MFSTARTUP_FULL,
    MFT_CATEGORY_VIDEO_DECODER, MFT_ENUM_FLAG_LOCALMFT, MFT_ENUM_FLAG_SORTANDFILTER,
    MFT_ENUM_FLAG_SYNCMFT, MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_STREAMING, MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES,
    MFT_REGISTER_TYPE_INFO, MF_E_NOTACCEPTING, MF_E_TRANSFORM_NEED_MORE_INPUT,
    MF_E_TRANSFORM_STREAM_CHANGE, MF_LOW_LATENCY, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_SUBTYPE, MF_MT_YUV_MATRIX, MF_VERSION,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};

use super::bitstream::{self, PlanarLayout, PlaneGeometry, StreamHeader};
use super::{DecodedFrame, DecoderConfig, EncodedFrame, VideoDecoder, VideoError};
use crate::video::{ColorSpace, PixelFormat};

const INPUT_STREAM: u32 = 0;
const OUTPUT_STREAM: u32 = 0;
/// Largest decoded dimension / pixel count accepted, as the libvpx decoder.
const MAX_DECODE_DIMENSION: u32 = 8192;
const MAX_DECODE_PIXELS: u32 = 7680 * 4320;
/// Bound on output pulls per input: a well-behaved MFT returns
/// NEED_MORE_INPUT after one or two pictures (plus at most one stream change).
const MAX_OUTPUT_PULLS: usize = 16;

/// Which codec an [`MfDecoder`] decodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MfDecodeCodec {
    H264,
    Av1,
}

impl MfDecodeCodec {
    fn label(self) -> &'static str {
        match self {
            Self::H264 => "H.264",
            Self::Av1 => "AV1",
        }
    }

    fn input_subtype(self) -> GUID {
        match self {
            Self::H264 => MFVideoFormat_H264,
            Self::Av1 => MFVideoFormat_AV1,
        }
    }

    /// The coded size + matrix from a parameter set in this access unit, if it
    /// carries one.
    fn stream_header(self, data: &[u8]) -> Result<Option<StreamHeader>, String> {
        match self {
            Self::H264 => bitstream::h264_stream_header(data),
            Self::Av1 => bitstream::av1_stream_header(data),
        }
    }
}

// ── Process-wide setup ───────────────────────────────────────────────

thread_local! {
    /// Whether this thread has joined the multithreaded apartment.
    static COM_READY: Cell<bool> = const { Cell::new(false) };
}

/// Join the calling thread to the MTA (once per thread). A thread that is
/// already single-threaded (`RPC_E_CHANGED_MODE`) can still call the
/// free-threaded MFTs.
fn ensure_com() -> Result<(), VideoError> {
    if COM_READY.with(Cell::get) {
        return Ok(());
    }
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_ok() || hr == RPC_E_CHANGED_MODE {
        COM_READY.with(|ready| ready.set(true));
        Ok(())
    } else {
        Err(VideoError::DecoderInit(format!(
            "CoInitializeEx failed: {hr}"
        )))
    }
}

fn ensure_media_foundation() -> Result<(), VideoError> {
    static STARTUP: OnceLock<Result<(), String>> = OnceLock::new();
    STARTUP
        .get_or_init(|| unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| format!("MFStartup failed: {err}"))
        })
        .clone()
        .map_err(VideoError::CodecUnavailable)
}

// ── Transform construction ───────────────────────────────────────────

/// The in-box Microsoft H.264 decoder.
fn create_h264_transform() -> Result<(IMFTransform, String), VideoError> {
    let transform: IMFTransform =
        unsafe { CoCreateInstance(&CLSID_MSH264DecoderMFT, None, CLSCTX_INPROC_SERVER) }.map_err(
            |err| {
                VideoError::CodecUnavailable(format!(
                    "the Microsoft H.264 decoder (CLSID_MSH264DecoderMFT) could not be created: \
                     {err}; on a Windows N edition install the Media Feature Pack"
                ))
            },
        )?;
    Ok((transform, "Microsoft H.264 Video Decoder MFT".to_string()))
}

/// The first synchronous, local AV1 decoder MFT on this machine.
fn create_av1_transform() -> Result<(IMFTransform, String), VideoError> {
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_AV1,
    };
    let mut activates: *mut Option<IMFActivate> = null_mut();
    let mut count = 0u32;
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_DECODER,
            MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_LOCALMFT | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            None,
            &mut activates,
            &mut count,
        )
    }
    .map_err(|err| {
        VideoError::CodecUnavailable(format!("MFTEnumEx (AV1 decoders) failed: {err}"))
    })?;

    let mut chosen = None;
    let mut failures = Vec::new();
    if !activates.is_null() {
        // Take ownership of every entry so each is released, then free the
        // array itself.
        let entries: Vec<Option<IMFActivate>> = unsafe {
            std::slice::from_raw_parts_mut(activates, count as usize)
                .iter_mut()
                .map(std::mem::take)
                .collect()
        };
        unsafe { CoTaskMemFree(Some(activates.cast())) };
        for activate in entries.into_iter().flatten() {
            let name = friendly_name(&activate);
            match unsafe { activate.ActivateObject::<IMFTransform>() } {
                Ok(transform) => {
                    chosen = Some((transform, name));
                    break;
                }
                Err(err) => failures.push(format!("{name}: {err}")),
            }
        }
    }
    chosen.ok_or_else(|| {
        if failures.is_empty() {
            VideoError::CodecUnavailable(
                "no Media Foundation AV1 decoder is installed (the \"AV1 Video Extension\" from \
                 the Microsoft Store provides one)"
                    .to_string(),
            )
        } else {
            VideoError::CodecUnavailable(format!(
                "no Media Foundation AV1 decoder could be activated: {}",
                failures.join("; ")
            ))
        }
    })
}

fn friendly_name(activate: &IMFActivate) -> String {
    let mut buffer = [0u16; 256];
    let mut length = 0u32;
    match unsafe {
        activate.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buffer, Some(&mut length))
    } {
        Ok(()) => String::from_utf16_lossy(&buffer[..(length as usize).min(buffer.len())]),
        Err(_) => "unnamed AV1 decoder MFT".to_string(),
    }
}

// ── Output format ────────────────────────────────────────────────────

/// The negotiated output type, read once per (re)negotiation.
#[derive(Debug, Clone, Copy)]
struct OutputFormat {
    layout: PlanarLayout,
    /// The media type's frame size: the allocated plane (e.g. 1920x1088).
    frame_width: u32,
    frame_height: u32,
    /// The visible picture (minimum display aperture, else the frame).
    crop: (u32, u32, u32, u32),
    /// `MF_MT_DEFAULT_STRIDE` when the type carries one (bytes per luma row).
    default_stride: Option<u32>,
    /// `MF_MT_YUV_MATRIX` when the type carries BT.601 / BT.709.
    matrix: Option<ColorSpace>,
    /// Output buffer size and alignment the MFT asks for when we allocate.
    buffer_size: u32,
    buffer_alignment: u32,
    /// Whether the MFT allocates output samples itself.
    provides_samples: bool,
}

fn offset_value(offset: MFOffset) -> u32 {
    offset.value.max(0) as u32
}

fn read_output_format(transform: &IMFTransform) -> Result<OutputFormat, String> {
    unsafe {
        let media_type = transform
            .GetOutputCurrentType(OUTPUT_STREAM)
            .map_err(|err| format!("GetOutputCurrentType failed: {err}"))?;
        let subtype = media_type
            .GetGUID(&MF_MT_SUBTYPE)
            .map_err(|err| format!("output type has no subtype: {err}"))?;
        let layout = layout_for_subtype(subtype)
            .ok_or_else(|| format!("output subtype {subtype:?} is neither I420 nor NV12"))?;
        // Before the first parameter set the decoder may not know the size
        // yet; the first picture then arrives as a stream change, which reads
        // this again.
        let packed = media_type.GetUINT64(&MF_MT_FRAME_SIZE).unwrap_or(0);
        let frame_width = (packed >> 32) as u32;
        let frame_height = packed as u32;

        let mut crop = (0, 0, frame_width, frame_height);
        let mut area = MFVideoArea::default();
        let area_bytes = std::slice::from_raw_parts_mut(
            (&mut area as *mut MFVideoArea).cast::<u8>(),
            std::mem::size_of::<MFVideoArea>(),
        );
        if media_type
            .GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, area_bytes, None)
            .is_ok()
            && area.Area.cx > 0
            && area.Area.cy > 0
        {
            crop = (
                offset_value(area.OffsetX),
                offset_value(area.OffsetY),
                area.Area.cx as u32,
                area.Area.cy as u32,
            );
        }

        // A negative default stride means a bottom-up image; planar YUV is
        // never bottom-up, so treat it as the magnitude.
        let default_stride = media_type
            .GetUINT32(&MF_MT_DEFAULT_STRIDE)
            .ok()
            .map(|raw| (raw as i32).unsigned_abs())
            .filter(|&stride| stride > 0);
        let matrix = match media_type.GetUINT32(&MF_MT_YUV_MATRIX) {
            Ok(value) if value == MFVideoTransferMatrix_BT709.0 as u32 => Some(ColorSpace::Bt709),
            Ok(value) if value == MFVideoTransferMatrix_BT601.0 as u32 => Some(ColorSpace::Bt601),
            _ => None,
        };

        let info = transform
            .GetOutputStreamInfo(OUTPUT_STREAM)
            .map_err(|err| format!("GetOutputStreamInfo failed: {err}"))?;
        let provides_samples = info.dwFlags
            & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
                | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32)
            != 0;

        Ok(OutputFormat {
            layout,
            frame_width,
            frame_height,
            crop,
            default_stride,
            matrix,
            buffer_size: info.cbSize,
            buffer_alignment: info.cbAlignment,
            provides_samples,
        })
    }
}

fn layout_for_subtype(subtype: GUID) -> Option<PlanarLayout> {
    if subtype == MFVideoFormat_I420 || subtype == MFVideoFormat_IYUV {
        Some(PlanarLayout::I420)
    } else if subtype == MFVideoFormat_NV12 {
        Some(PlanarLayout::Nv12)
    } else {
        None
    }
}

/// Pick and set the output type: the first I420/IYUV the MFT offers, else the
/// first NV12. Called at construction and on every stream change.
fn negotiate_output_type(transform: &IMFTransform) -> Result<OutputFormat, String> {
    let mut i420: Option<IMFMediaType> = None;
    let mut nv12: Option<IMFMediaType> = None;
    let mut offered = Vec::new();
    for index in 0.. {
        let media_type = match unsafe { transform.GetOutputAvailableType(OUTPUT_STREAM, index) } {
            Ok(media_type) => media_type,
            Err(_) => break,
        };
        let Ok(subtype) = (unsafe { media_type.GetGUID(&MF_MT_SUBTYPE) }) else {
            continue;
        };
        match layout_for_subtype(subtype) {
            Some(PlanarLayout::I420) if i420.is_none() => i420 = Some(media_type),
            Some(PlanarLayout::Nv12) if nv12.is_none() => nv12 = Some(media_type),
            _ => offered.push(format!("{subtype:?}")),
        }
    }
    let chosen = i420.or(nv12).ok_or_else(|| {
        format!(
            "the decoder offers no I420 or NV12 output (offered: {})",
            if offered.is_empty() {
                "nothing".to_string()
            } else {
                offered.join(", ")
            }
        )
    })?;
    unsafe { transform.SetOutputType(OUTPUT_STREAM, &chosen, 0) }
        .map_err(|err| format!("SetOutputType failed: {err}"))?;
    read_output_format(transform)
}

// ── Decoder ──────────────────────────────────────────────────────────

/// A Media Foundation H.264 or AV1 decoder producing CPU I420.
pub(crate) struct MfDecoder {
    codec: MfDecodeCodec,
    transform: IMFTransform,
    backend: String,
    config: DecoderConfig,
    needs_keyframe: bool,
    output: OutputFormat,
    /// The matrix the stream last signaled in a parameter set.
    stream_matrix: Option<ColorSpace>,
    /// Reused output sample when the MFT does not allocate its own (it is
    /// copied out before the next pull, so one is enough).
    output_sample: Option<(IMFSample, u32)>,
}

// Safety: the transform is a free-threaded ("Both") in-process COM object; the
// decoder is only ever used by one thread at a time (the pipeline holds it
// behind a mutex) and every entry point joins the calling thread to the MTA
// first (`ensure_com`).
unsafe impl Send for MfDecoder {}

impl MfDecoder {
    pub(crate) fn new(codec: MfDecodeCodec, config: DecoderConfig) -> Result<Self, VideoError> {
        if config.pixel_format != PixelFormat::I420 {
            return Err(VideoError::UnsupportedPixelFormat(config.pixel_format));
        }
        ensure_com()?;
        ensure_media_foundation()?;
        let (transform, backend) = match codec {
            MfDecodeCodec::H264 => create_h264_transform()?,
            MfDecodeCodec::Av1 => create_av1_transform()?,
        };
        let init = |what: &str, err: windows::core::Error| {
            VideoError::DecoderInit(format!("{} {what} failed: {err}", codec.label()))
        };
        unsafe {
            // Emit every picture as soon as it can be shown (no reorder wait).
            // A transform without an attribute store simply has no knob.
            if let Ok(attributes) = transform.GetAttributes() {
                attributes
                    .SetUINT32(&MF_LOW_LATENCY, 1)
                    .map_err(|err| init("setting MF_LOW_LATENCY", err))?;
            }

            let input = MFCreateMediaType().map_err(|err| init("MFCreateMediaType", err))?;
            input
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(|err| init("setting the input major type", err))?;
            input
                .SetGUID(&MF_MT_SUBTYPE, &codec.input_subtype())
                .map_err(|err| init("setting the input subtype", err))?;
            transform
                .SetInputType(INPUT_STREAM, &input, 0)
                .map_err(|err| init("SetInputType", err))?;
        }
        let output = negotiate_output_type(&transform).map_err(|reason| {
            VideoError::DecoderInit(format!("{} output type: {reason}", codec.label()))
        })?;
        unsafe {
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(|err| init("NOTIFY_BEGIN_STREAMING", err))?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|err| init("NOTIFY_START_OF_STREAM", err))?;
        }
        tracing::info!(
            codec = codec.label(),
            backend = backend.as_str(),
            "media foundation decoder ready (software, system-memory output)"
        );
        Ok(Self {
            codec,
            transform,
            backend,
            config,
            needs_keyframe: true,
            output,
            stream_matrix: None,
            output_sample: None,
        })
    }

    /// The MFT's friendly name (diagnostics).
    #[allow(dead_code)]
    pub(crate) fn backend_name(&self) -> &str {
        &self.backend
    }

    fn fail(&mut self, reason: String) -> VideoError {
        self.needs_keyframe = true;
        VideoError::DecodeFailed(format!(
            "{} ({}): {reason}",
            self.codec.label(),
            self.backend
        ))
    }

    fn check_size(&self, width: u32, height: u32) -> Result<(), String> {
        let (max_w, max_h, max_px) = crate::video::negotiated_decode_ceiling(
            self.config.max_dimensions,
            MAX_DECODE_DIMENSION,
            MAX_DECODE_PIXELS,
        );
        let within = width > 0
            && height > 0
            && width <= max_w
            && height <= max_h
            && width.checked_mul(height).is_some_and(|px| px <= max_px);
        if within {
            Ok(())
        } else {
            Err(format!(
                "stream resolution out of bounds: {width}x{height} (max {max_w}x{max_h})"
            ))
        }
    }

    fn input_sample(&self, frame: &EncodedFrame) -> Result<IMFSample, String> {
        let length =
            u32::try_from(frame.data.len()).map_err(|_| "access unit too large".to_string())?;
        unsafe {
            let sample = MFCreateSample().map_err(|err| format!("MFCreateSample failed: {err}"))?;
            let buffer = MFCreateMemoryBuffer(length.max(1))
                .map_err(|err| format!("MFCreateMemoryBuffer failed: {err}"))?;
            let mut ptr = null_mut();
            buffer
                .Lock(&mut ptr, None, None)
                .map_err(|err| format!("input buffer lock failed: {err}"))?;
            std::ptr::copy_nonoverlapping(frame.data.as_ptr(), ptr, frame.data.len());
            let unlock = buffer.Unlock();
            unlock.map_err(|err| format!("input buffer unlock failed: {err}"))?;
            buffer
                .SetCurrentLength(length)
                .map_err(|err| format!("SetCurrentLength failed: {err}"))?;
            sample
                .AddBuffer(&buffer)
                .map_err(|err| format!("AddBuffer failed: {err}"))?;
            // The MFT carries the time through to the picture untouched.
            sample
                .SetSampleTime(frame.pts)
                .map_err(|err| format!("SetSampleTime failed: {err}"))?;
            if frame.is_keyframe {
                sample
                    .SetUINT32(&MFSampleExtension_CleanPoint, 1)
                    .map_err(|err| format!("marking the clean point failed: {err}"))?;
            }
            Ok(sample)
        }
    }

    /// The sample to hand `ProcessOutput`: `None` when the MFT allocates.
    fn output_sample_for_pull(&mut self) -> Result<Option<IMFSample>, String> {
        if self.output.provides_samples {
            return Ok(None);
        }
        let wanted = self
            .output
            .buffer_size
            .max(
                PixelFormat::I420.frame_size(self.output.frame_width, self.output.frame_height)
                    as u32,
            )
            .max(1);
        if let Some((sample, capacity)) = &self.output_sample {
            if *capacity >= wanted {
                return Ok(Some(sample.clone()));
            }
        }
        unsafe {
            let buffer = if self.output.buffer_alignment > 1 {
                MFCreateAlignedMemoryBuffer(wanted, self.output.buffer_alignment - 1)
            } else {
                MFCreateMemoryBuffer(wanted)
            }
            .map_err(|err| format!("output buffer allocation failed: {err}"))?;
            let sample = MFCreateSample().map_err(|err| format!("MFCreateSample failed: {err}"))?;
            sample
                .AddBuffer(&buffer)
                .map_err(|err| format!("AddBuffer failed: {err}"))?;
            self.output_sample = Some((sample.clone(), wanted));
            Ok(Some(sample))
        }
    }

    /// Pull every picture the MFT has ready.
    fn collect(&mut self, fallback_pts: i64) -> Result<Vec<DecodedFrame>, String> {
        let mut frames = Vec::new();
        for _ in 0..MAX_OUTPUT_PULLS {
            let provided = self.output_sample_for_pull()?;
            let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: OUTPUT_STREAM,
                pSample: ManuallyDrop::new(provided),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            }];
            let mut status = 0u32;
            let result = unsafe { self.transform.ProcessOutput(0, &mut buffers, &mut status) };
            // Take the COM references back so they are released on every path.
            let sample = unsafe { ManuallyDrop::take(&mut buffers[0].pSample) };
            let _events = unsafe { ManuallyDrop::take(&mut buffers[0].pEvents) };
            match result {
                Ok(()) => {
                    let Some(sample) = sample else {
                        return Err("ProcessOutput succeeded without a sample".to_string());
                    };
                    frames.push(self.convert(&sample, fallback_pts)?);
                }
                Err(err) if err.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(frames),
                Err(err) if err.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    let output = negotiate_output_type(&self.transform)
                        .map_err(|reason| format!("stream change: {reason}"))?;
                    self.check_size(output.frame_width, output.frame_height)?;
                    if output.frame_width != self.output.frame_width
                        || output.frame_height != self.output.frame_height
                    {
                        tracing::info!(
                            codec = self.codec.label(),
                            width = output.frame_width,
                            height = output.frame_height,
                            "media foundation decoder output renegotiated"
                        );
                    }
                    self.output = output;
                    self.output_sample = None;
                }
                Err(err) => return Err(format!("ProcessOutput failed: {err}")),
            }
        }
        Err(format!(
            "the decoder produced output {MAX_OUTPUT_PULLS} times for one input without asking \
             for more"
        ))
    }

    /// Copy one decoded picture out as tight I420.
    fn convert(&self, sample: &IMFSample, fallback_pts: i64) -> Result<DecodedFrame, String> {
        let output = self.output;
        let (crop_x, crop_y, crop_w, crop_h) = output.crop;
        self.check_size(crop_w, crop_h)?;
        let colorspace = self
            .stream_matrix
            .or(output.matrix)
            .unwrap_or(ColorSpace::Bt709);
        let pts = unsafe { sample.GetSampleTime() }.unwrap_or(fallback_pts);
        let geometry = |pitch: usize| PlaneGeometry {
            layout: output.layout,
            pitch,
            plane_rows: output.frame_height as usize,
            crop_x: crop_x as usize,
            crop_y: crop_y as usize,
            crop_width: crop_w as usize,
            crop_height: crop_h as usize,
        };

        let buffer: IMFMediaBuffer = unsafe {
            if sample.GetBufferCount().unwrap_or(0) == 1 {
                sample.GetBufferByIndex(0)
            } else {
                sample.ConvertToContiguousBuffer()
            }
        }
        .map_err(|err| format!("reading the output buffer failed: {err}"))?;

        let repacked = if let Ok(buffer_2d) = buffer.cast::<IMF2DBuffer2>() {
            // A 2D buffer knows its own pitch; read it exactly as laid out.
            let mut scanline0 = null_mut();
            let mut pitch = 0i32;
            let mut start = null_mut();
            let mut length = 0u32;
            unsafe {
                buffer_2d
                    .Lock2DSize(
                        MF2DBuffer_LockFlags_Read,
                        &mut scanline0,
                        &mut pitch,
                        &mut start,
                        &mut length,
                    )
                    .map_err(|err| format!("Lock2DSize failed: {err}"))?;
            }
            let result = if pitch <= 0 || scanline0.is_null() {
                Err(format!("output buffer has an unusable pitch {pitch}"))
            } else {
                // The planes start at scanline 0 and run to the end of the
                // locked buffer.
                let available = (length as usize)
                    .saturating_sub((scanline0 as usize).saturating_sub(start as usize));
                let bytes = unsafe { std::slice::from_raw_parts(scanline0, available) };
                bitstream::repack_to_i420(bytes, &geometry(pitch as usize))
            };
            unsafe {
                let _ = buffer_2d.Unlock2D();
            }
            result
        } else {
            let stride = output
                .default_stride
                .unwrap_or(output.frame_width)
                .max(output.frame_width) as usize;
            let mut ptr = null_mut();
            let mut current = 0u32;
            unsafe {
                buffer
                    .Lock(&mut ptr, None, Some(&mut current))
                    .map_err(|err| format!("output buffer lock failed: {err}"))?;
            }
            let bytes = unsafe { std::slice::from_raw_parts(ptr, current as usize) };
            let result = bitstream::repack_to_i420(bytes, &geometry(stride));
            unsafe {
                let _ = buffer.Unlock();
            }
            result
        }?;

        let (data, width, height) = repacked;
        Ok(DecodedFrame {
            data,
            pixel_format: PixelFormat::I420,
            width,
            height,
            pts,
            colorspace,
        })
    }
}

impl VideoDecoder for MfDecoder {
    fn decode(&mut self, frame: &EncodedFrame) -> Result<Vec<DecodedFrame>, VideoError> {
        if self.needs_keyframe && !frame.is_keyframe {
            return Err(VideoError::KeyframeRequired);
        }
        ensure_com()?;

        // Refuse an oversized (or undrawable) stream before the MFT allocates
        // for it. The outer keyframe flag is untrusted, so every access unit is
        // inspected, not only the ones flagged as keyframes.
        match self.codec.stream_header(&frame.data) {
            Ok(Some(header)) => {
                if let Err(reason) = self.check_size(header.coded_width, header.coded_height) {
                    return Err(self.fail(reason));
                }
                self.stream_matrix = header.matrix;
            }
            Ok(None) => {}
            Err(reason) => return Err(self.fail(reason)),
        }

        if frame.is_keyframe {
            self.needs_keyframe = false;
        }

        let sample = match self.input_sample(frame) {
            Ok(sample) => sample,
            Err(reason) => return Err(self.fail(reason)),
        };
        let mut frames = Vec::new();
        let mut accepted = unsafe { self.transform.ProcessInput(INPUT_STREAM, &sample, 0) };
        if matches!(&accepted, Err(err) if err.code() == MF_E_NOTACCEPTING) {
            // Output is pending from an earlier input: pull it, then retry once.
            match self.collect(frame.pts) {
                Ok(mut pending) => frames.append(&mut pending),
                Err(reason) => return Err(self.fail(reason)),
            }
            accepted = unsafe { self.transform.ProcessInput(INPUT_STREAM, &sample, 0) };
        }
        if let Err(err) = accepted {
            return Err(self.fail(format!("ProcessInput failed: {err}")));
        }
        match self.collect(frame.pts) {
            Ok(mut decoded) => frames.append(&mut decoded),
            Err(reason) => return Err(self.fail(reason)),
        }
        Ok(frames)
    }

    fn needs_keyframe(&self) -> bool {
        self.needs_keyframe
    }

    fn clear_keyframe_request(&mut self) {
        self.needs_keyframe = false;
    }

    fn reset(&mut self) -> Result<(), VideoError> {
        ensure_com()?;
        self.needs_keyframe = true;
        self.stream_matrix = None;
        unsafe { self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0) }.map_err(|err| {
            VideoError::DecodeFailed(format!("{} flush failed: {err}", self.codec.label()))
        })
    }

    fn config(&self) -> &DecoderConfig {
        &self.config
    }
}

impl Drop for MfDecoder {
    fn drop(&mut self) {
        if ensure_com().is_ok() {
            unsafe {
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
        }
    }
}
