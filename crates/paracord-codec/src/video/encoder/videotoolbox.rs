//! VideoToolbox H.264 encoder and decoder (macOS).
//!
//! macOS ships no libavcodec hardware encoder in this project (the `lavc`
//! engine is Linux-only) and no Media Foundation (Windows-only), so before this
//! module every Mac fell through to CPU libvpx VP9 at `cpu_used` 6–9. This wires
//! the platform's real hardware video codec — VideoToolbox — behind the
//! [`VideoEncoder`]/[`VideoDecoder`] traits:
//!
//! - [`VideoToolboxH264Encoder`]: a `VTCompressionSession` in realtime mode,
//!   CBR-ish capped VBR (`AverageBitRate` + `DataRateLimits` ≈1.5×), no B-frames
//!   (`AllowFrameReordering = false`), per-frame keyframes via
//!   `kVTEncodeFrameOptionKey_ForceKeyFrame`, live bitrate retargeting via
//!   `VTSessionSetProperty(AverageBitRate)`. Accepts BGRA/RGBA/I420 input and
//!   builds the matching `CVPixelBuffer` so VideoToolbox does any RGB→YUV
//!   conversion on the GPU (no CPU I420 pass for packed input). Output is
//!   converted from AVCC length-prefixed to Annex-B, prepending the format
//!   description's SPS/PPS on keyframes. BT.709 limited range is signaled per
//!   contract C1.
//! - [`VideoToolboxH264Decoder`]: a `VTDecompressionSession` producing planar
//!   I420. The format description is built (and the session rebuilt) from the
//!   SPS/PPS carried in each keyframe; incoming Annex-B is repacked to AVCC.
//!
//! Everything here is gated `#[cfg(target_os = "macos")]` at the module
//! declaration site, so the Linux/Windows builds never see it. The FFI is
//! declared directly against the VideoToolbox / CoreMedia / CoreVideo /
//! CoreFoundation frameworks (linked via `#[link(kind = "framework")]`); no
//! external crate is required.

#![allow(non_upper_case_globals, non_snake_case)]

use crate::video::decoder::{DecodeOutput, VideoDecoder};
use crate::video::encoder::VideoEncoder;
use crate::video::handle::CvPixelBufferFrame;
use crate::video::{
    ColorSpace, DecodedFrame, DecodedFrameHandle, DecoderConfig, EncodedFrame, EncoderConfig,
    PixelFormat, VideoCodec, VideoError,
};
use std::os::raw::{c_int, c_void};
use std::ptr;
use std::sync::Mutex;

// ── Framework FFI ────────────────────────────────────────────────────

type CFTypeRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFStringRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFMutableDictionaryRef = *mut c_void;
type CFArrayRef = *const c_void;
type CFNumberRef = *const c_void;
type CFBooleanRef = *const c_void;
type CFNumberType = isize;
type CFIndex = isize;
type Boolean = u8;
type OSStatus = i32;
type CVReturn = i32;
type FourCharCode = u32;
type CMVideoCodecType = FourCharCode;
type CMItemCount = isize;

type VTCompressionSessionRef = *mut c_void;
type VTDecompressionSessionRef = *mut c_void;
type VTSessionRef = *mut c_void;
type CMSampleBufferRef = *mut c_void;
type CMBlockBufferRef = *mut c_void;
type CMFormatDescriptionRef = *mut c_void;
type CVPixelBufferRef = *mut c_void;
type CVImageBufferRef = *mut c_void;

type VTEncodeInfoFlags = u32;
type VTDecodeInfoFlags = u32;
type VTDecodeFrameFlags = u32;
type CMBlockBufferFlags = u32;

/// FourCC codec / pixel-format constants.
const kCMVideoCodecType_H264: CMVideoCodecType = 0x6176_6331; // 'avc1'
/// AV1 (`'av01'`) — for the `VTIsHardwareDecodeSupported` probe that gates the
/// macOS AV1 native-surface route (spec §2/§3.5; hardware AV1 decode is M3+).
const kCMVideoCodecType_AV1: CMVideoCodecType = 0x6176_3031; // 'av01'
const kCVPixelFormatType_32BGRA: FourCharCode = 0x4247_5241; // 'BGRA'
const kCVPixelFormatType_32RGBA: FourCharCode = 0x5247_4241; // 'RGBA'
const kCVPixelFormatType_420YpCbCr8Planar: FourCharCode = 0x7934_3230; // 'y420'
/// NV12 (bi-planar Y + interleaved CbCr, video range) — the canonical hardware
/// decode output and the format an `AVSampleBufferDisplayLayer` presents
/// zero-copy. Requested as the destination for the GPU (CVPixelBuffer) decode
/// path (spec §3.2/§3.5) so the retained buffer feeds the display layer with no
/// CPU pass.
const kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange: FourCharCode = 0x3432_3076; // '420v'

const kCFNumberSInt32Type: CFNumberType = 3;
const kCFNumberSInt64Type: CFNumberType = 4;

/// `kCMTimeFlags_Valid`.
const kCMTimeFlags_Valid: u32 = 1 << 0;
/// `kCMBlockBufferAssureMemoryNowFlag`.
const kCMBlockBufferAssureMemoryNowFlag: CMBlockBufferFlags = 1 << 0;

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

impl CMTime {
    const INVALID: CMTime = CMTime {
        value: 0,
        timescale: 0,
        flags: 0,
        epoch: 0,
    };
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CMSampleTimingInfo {
    duration: CMTime,
    presentationTimeStamp: CMTime,
    decodeTimeStamp: CMTime,
}

type VTCompressionOutputCallback = Option<
    unsafe extern "C" fn(
        outputCallbackRefCon: *mut c_void,
        sourceFrameRefCon: *mut c_void,
        status: OSStatus,
        infoFlags: VTEncodeInfoFlags,
        sampleBuffer: CMSampleBufferRef,
    ),
>;

type VTDecompressionOutputCallback = Option<
    unsafe extern "C" fn(
        decompressionOutputRefCon: *mut c_void,
        sourceFrameRefCon: *mut c_void,
        status: OSStatus,
        infoFlags: VTDecodeInfoFlags,
        imageBuffer: CVImageBufferRef,
        presentationTimeStamp: CMTime,
        presentationDuration: CMTime,
    ),
>;

#[repr(C)]
struct VTDecompressionOutputCallbackRecord {
    decompressionOutputCallback: VTDecompressionOutputCallback,
    decompressionOutputRefCon: *mut c_void,
}

#[link(name = "VideoToolbox", kind = "framework")]
#[link(name = "CoreMedia", kind = "framework")]
#[link(name = "CoreVideo", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    // CoreFoundation
    fn CFRelease(cf: CFTypeRef);
    fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> Boolean;
    fn CFNumberCreate(
        allocator: CFAllocatorRef,
        the_type: CFNumberType,
        value_ptr: *const c_void,
    ) -> CFNumberRef;
    fn CFDictionaryCreateMutable(
        allocator: CFAllocatorRef,
        capacity: CFIndex,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFMutableDictionaryRef;
    fn CFDictionarySetValue(dict: CFMutableDictionaryRef, key: *const c_void, value: *const c_void);
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFArrayCreate(
        allocator: CFAllocatorRef,
        values: *const *const c_void,
        num_values: CFIndex,
        callbacks: *const c_void,
    ) -> CFArrayRef;
    fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: CFIndex) -> *const c_void;
    fn CFBooleanGetValue(boolean: CFBooleanRef) -> Boolean;

    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    static kCFTypeArrayCallBacks: c_void;
    static kCFBooleanTrue: CFBooleanRef;
    static kCFBooleanFalse: CFBooleanRef;

    // CoreMedia
    fn CMTimeMake(value: i64, timescale: i32) -> CMTime;
    fn CMSampleBufferGetDataBuffer(sbuf: CMSampleBufferRef) -> CMBlockBufferRef;
    fn CMSampleBufferGetFormatDescription(sbuf: CMSampleBufferRef) -> CMFormatDescriptionRef;
    fn CMSampleBufferGetPresentationTimeStamp(sbuf: CMSampleBufferRef) -> CMTime;
    fn CMSampleBufferGetSampleAttachmentsArray(
        sbuf: CMSampleBufferRef,
        create_if_necessary: Boolean,
    ) -> CFArrayRef;
    fn CMSampleBufferCreateReady(
        allocator: CFAllocatorRef,
        data_buffer: CMBlockBufferRef,
        format_description: CMFormatDescriptionRef,
        num_samples: CMItemCount,
        num_sample_timing_entries: CMItemCount,
        sample_timing_array: *const CMSampleTimingInfo,
        num_sample_size_entries: CMItemCount,
        sample_size_array: *const usize,
        sbuf_out: *mut CMSampleBufferRef,
    ) -> OSStatus;
    fn CMBlockBufferGetDataLength(bbuf: CMBlockBufferRef) -> usize;
    fn CMBlockBufferCopyDataBytes(
        source: CMBlockBufferRef,
        offset_to_data: usize,
        data_length: usize,
        destination: *mut c_void,
    ) -> OSStatus;
    fn CMBlockBufferCreateWithMemoryBlock(
        allocator: CFAllocatorRef,
        memory_block: *mut c_void,
        block_length: usize,
        block_allocator: CFAllocatorRef,
        custom_block_source: *const c_void,
        offset_to_data: usize,
        data_length: usize,
        flags: CMBlockBufferFlags,
        bbuf_out: *mut CMBlockBufferRef,
    ) -> OSStatus;
    fn CMBlockBufferReplaceDataBytes(
        source_bytes: *const c_void,
        destination: CMBlockBufferRef,
        offset_into_destination: usize,
        data_length: usize,
    ) -> OSStatus;
    fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        video_desc: CMFormatDescriptionRef,
        parameter_set_index: usize,
        parameter_set_pointer_out: *mut *const u8,
        parameter_set_size_out: *mut usize,
        parameter_set_count_out: *mut usize,
        nal_unit_header_length_out: *mut c_int,
    ) -> OSStatus;
    fn CMVideoFormatDescriptionCreateFromH264ParameterSets(
        allocator: CFAllocatorRef,
        parameter_set_count: usize,
        parameter_set_pointers: *const *const u8,
        parameter_set_sizes: *const usize,
        nal_unit_header_length: c_int,
        format_description_out: *mut CMFormatDescriptionRef,
    ) -> OSStatus;

    // CoreVideo
    fn CVPixelBufferCreate(
        allocator: CFAllocatorRef,
        width: usize,
        height: usize,
        pixel_format_type: FourCharCode,
        pixel_buffer_attributes: CFDictionaryRef,
        pixel_buffer_out: *mut CVPixelBufferRef,
    ) -> CVReturn;
    fn CVPixelBufferLockBaseAddress(pb: CVPixelBufferRef, lock_flags: u64) -> CVReturn;
    fn CVPixelBufferUnlockBaseAddress(pb: CVPixelBufferRef, lock_flags: u64) -> CVReturn;
    fn CVPixelBufferGetBaseAddress(pb: CVPixelBufferRef) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRow(pb: CVPixelBufferRef) -> usize;
    fn CVPixelBufferGetBaseAddressOfPlane(pb: CVPixelBufferRef, plane: usize) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRowOfPlane(pb: CVPixelBufferRef, plane: usize) -> usize;
    fn CVPixelBufferGetWidth(pb: CVPixelBufferRef) -> usize;
    fn CVPixelBufferGetHeight(pb: CVPixelBufferRef) -> usize;
    fn CVPixelBufferGetWidthOfPlane(pb: CVPixelBufferRef, plane: usize) -> usize;
    fn CVPixelBufferGetHeightOfPlane(pb: CVPixelBufferRef, plane: usize) -> usize;
    fn CVBufferGetAttachment(
        buffer: CVImageBufferRef,
        key: CFStringRef,
        attachment_mode_out: *mut u32,
    ) -> CFTypeRef;

    static kCVPixelBufferPixelFormatTypeKey: CFStringRef;
    static kCVPixelBufferIOSurfacePropertiesKey: CFStringRef;
    static kCVImageBufferYCbCrMatrixKey: CFStringRef;
    static kCVImageBufferYCbCrMatrix_ITU_R_601_4: CFStringRef;
    static kCVImageBufferYCbCrMatrix_SMPTE_240M_1995: CFStringRef;

    // VideoToolbox — compression
    fn VTCompressionSessionCreate(
        allocator: CFAllocatorRef,
        width: i32,
        height: i32,
        codec_type: CMVideoCodecType,
        encoder_specification: CFDictionaryRef,
        source_image_buffer_attributes: CFDictionaryRef,
        compressed_data_allocator: CFAllocatorRef,
        output_callback: VTCompressionOutputCallback,
        output_callback_refcon: *mut c_void,
        compression_session_out: *mut VTCompressionSessionRef,
    ) -> OSStatus;
    fn VTCompressionSessionPrepareToEncodeFrames(session: VTCompressionSessionRef) -> OSStatus;
    fn VTCompressionSessionEncodeFrame(
        session: VTCompressionSessionRef,
        image_buffer: CVImageBufferRef,
        presentation_timestamp: CMTime,
        duration: CMTime,
        frame_properties: CFDictionaryRef,
        source_frame_refcon: *mut c_void,
        info_flags_out: *mut VTEncodeInfoFlags,
    ) -> OSStatus;
    fn VTCompressionSessionCompleteFrames(
        session: VTCompressionSessionRef,
        complete_until_presentation_timestamp: CMTime,
    ) -> OSStatus;
    fn VTCompressionSessionInvalidate(session: VTCompressionSessionRef);

    // VideoToolbox — decompression
    fn VTDecompressionSessionCreate(
        allocator: CFAllocatorRef,
        video_format_description: CMFormatDescriptionRef,
        video_decoder_specification: CFDictionaryRef,
        destination_image_buffer_attributes: CFDictionaryRef,
        output_callback: *const VTDecompressionOutputCallbackRecord,
        decompression_session_out: *mut VTDecompressionSessionRef,
    ) -> OSStatus;
    fn VTDecompressionSessionDecodeFrame(
        session: VTDecompressionSessionRef,
        sample_buffer: CMSampleBufferRef,
        decode_flags: VTDecodeFrameFlags,
        source_frame_refcon: *mut c_void,
        info_flags_out: *mut VTDecodeInfoFlags,
    ) -> OSStatus;
    fn VTDecompressionSessionWaitForAsynchronousFrames(
        session: VTDecompressionSessionRef,
    ) -> OSStatus;
    fn VTDecompressionSessionInvalidate(session: VTDecompressionSessionRef);
    /// Whether the OS has a *hardware* decoder for `codec_type` on this machine.
    /// Backs the honest `decode_hardware` advertisement (spec M3): true only when
    /// the platform confirms hardware decode, never merely software availability.
    fn VTIsHardwareDecodeSupported(codec_type: CMVideoCodecType) -> Boolean;

    // VideoToolbox — shared session property access
    fn VTSessionSetProperty(session: VTSessionRef, key: CFStringRef, value: CFTypeRef) -> OSStatus;
    fn VTSessionCopyProperty(
        session: VTSessionRef,
        key: CFStringRef,
        allocator: CFAllocatorRef,
        value_out: *mut CFTypeRef,
    ) -> OSStatus;

    static kVTCompressionPropertyKey_RealTime: CFStringRef;
    static kVTCompressionPropertyKey_AllowFrameReordering: CFStringRef;
    static kVTCompressionPropertyKey_AverageBitRate: CFStringRef;
    static kVTCompressionPropertyKey_DataRateLimits: CFStringRef;
    static kVTCompressionPropertyKey_MaxKeyFrameInterval: CFStringRef;
    static kVTCompressionPropertyKey_ProfileLevel: CFStringRef;
    static kVTProfileLevel_H264_High_AutoLevel: CFStringRef;
    static kVTCompressionPropertyKey_ExpectedFrameRate: CFStringRef;
    static kVTCompressionPropertyKey_ColorPrimaries: CFStringRef;
    static kVTCompressionPropertyKey_TransferFunction: CFStringRef;
    static kVTCompressionPropertyKey_YCbCrMatrix: CFStringRef;
    static kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder: CFStringRef;
    static kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: CFStringRef;
    static kVTEncodeFrameOptionKey_ForceKeyFrame: CFStringRef;

    static kCVImageBufferColorPrimaries_ITU_R_709_2: CFStringRef;
    static kCVImageBufferTransferFunction_ITU_R_709_2: CFStringRef;
    static kCVImageBufferYCbCrMatrix_ITU_R_709_2: CFStringRef;
}

// ── Small FFI helpers ────────────────────────────────────────────────

#[inline]
unsafe fn cf_release(cf: *const c_void) {
    if !cf.is_null() {
        CFRelease(cf);
    }
}

unsafe fn cfnum_i32(v: i32) -> CFNumberRef {
    CFNumberCreate(
        ptr::null(),
        kCFNumberSInt32Type,
        &v as *const i32 as *const c_void,
    )
}

unsafe fn cfnum_i64(v: i64) -> CFNumberRef {
    CFNumberCreate(
        ptr::null(),
        kCFNumberSInt64Type,
        &v as *const i64 as *const c_void,
    )
}

unsafe fn new_cf_dict() -> CFMutableDictionaryRef {
    CFDictionaryCreateMutable(
        ptr::null(),
        0,
        &kCFTypeDictionaryKeyCallBacks as *const c_void,
        &kCFTypeDictionaryValueCallBacks as *const c_void,
    )
}

unsafe fn set_session_bool(session: VTSessionRef, key: CFStringRef, val: bool) -> OSStatus {
    let boolean = if val { kCFBooleanTrue } else { kCFBooleanFalse };
    VTSessionSetProperty(session, key, boolean)
}

unsafe fn set_session_i32(session: VTSessionRef, key: CFStringRef, v: i32) -> OSStatus {
    let n = cfnum_i32(v);
    let ret = VTSessionSetProperty(session, key, n);
    cf_release(n);
    ret
}

unsafe fn set_session_cfstr(
    session: VTSessionRef,
    key: CFStringRef,
    value: CFStringRef,
) -> OSStatus {
    VTSessionSetProperty(session, key, value)
}

/// Map our [`PixelFormat`] to the CoreVideo pixel-format FourCC used to build
/// the input `CVPixelBuffer`. Packed formats let VideoToolbox convert to YUV on
/// the GPU (no CPU pass); `I420` is uploaded as a planar buffer.
fn cv_pixel_format(pf: PixelFormat) -> FourCharCode {
    match pf {
        PixelFormat::Bgra => kCVPixelFormatType_32BGRA,
        PixelFormat::Rgba => kCVPixelFormatType_32RGBA,
        PixelFormat::I420 => kCVPixelFormatType_420YpCbCr8Planar,
    }
}

// ── Encoder ──────────────────────────────────────────────────────────

/// Frames collected by the compression output callback, drained by `encode` /
/// `flush`. Behind a `Mutex` because VideoToolbox may invoke the callback on an
/// internal dispatch thread.
struct EncoderOutput {
    frames: Vec<EncodedFrame>,
    error: Option<String>,
    width: u32,
    height: u32,
}

/// Hardware-accelerated (when available) H.264 encoder backed by a
/// `VTCompressionSession`.
pub struct VideoToolboxH264Encoder {
    session: VTCompressionSessionRef,
    /// Boxed so its address is stable: it is handed to VideoToolbox as the
    /// output-callback refcon and must outlive the session.
    output: Box<Mutex<EncoderOutput>>,
    config: EncoderConfig,
    hardware: bool,
}

// Safety: the session and callback refcon are only ever touched through
// `&mut self`; the callback synchronizes on the `Mutex`. Mirrors the other
// encoders' hand-written `Send`.
unsafe impl Send for VideoToolboxH264Encoder {}

impl VideoToolboxH264Encoder {
    /// Create an encoder for `config`. The input `CVPixelBuffer` format follows
    /// `config.pixel_format`; the encoder emits Annex-B H.264 at
    /// `config.width`×`config.height`.
    pub fn new(config: EncoderConfig) -> Result<Self, VideoError> {
        config.validate()?;
        if !matches!(
            config.pixel_format,
            PixelFormat::I420 | PixelFormat::Bgra | PixelFormat::Rgba
        ) {
            return Err(VideoError::UnsupportedPixelFormat(config.pixel_format));
        }

        let output = Box::new(Mutex::new(EncoderOutput {
            frames: Vec::new(),
            error: None,
            width: config.width,
            height: config.height,
        }));
        let refcon = &*output as *const Mutex<EncoderOutput> as *mut c_void;

        unsafe {
            // Encoder specification: request (but do not require) a hardware
            // encoder. Requiring it would fail on the rare Mac without one; we
            // instead query what was actually selected below and report that.
            let spec = new_cf_dict();
            if spec.is_null() {
                return Err(VideoError::EncoderInit(
                    "CFDictionaryCreateMutable (encoder spec) failed".into(),
                ));
            }
            CFDictionarySetValue(
                spec,
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as *const c_void,
                kCFBooleanTrue as *const c_void,
            );

            let mut session: VTCompressionSessionRef = ptr::null_mut();
            let status = VTCompressionSessionCreate(
                ptr::null(),
                config.width as i32,
                config.height as i32,
                kCMVideoCodecType_H264,
                spec,
                ptr::null(), // let VT choose the source pixel-buffer pool
                ptr::null(),
                Some(compression_output_callback),
                refcon,
                &mut session,
            );
            cf_release(spec);
            if status != 0 || session.is_null() {
                return Err(VideoError::EncoderInit(format!(
                    "VTCompressionSessionCreate failed: OSStatus {status}"
                )));
            }

            let mut enc = Self {
                session,
                output,
                config,
                hardware: false,
            };
            if let Err(err) = enc.configure() {
                // `enc`'s Drop invalidates the session.
                return Err(err);
            }
            enc.hardware = enc.query_hardware();
            Ok(enc)
        }
    }

    /// Whether VideoToolbox selected a hardware encoder for this session.
    pub fn is_hardware(&self) -> bool {
        self.hardware
    }

    unsafe fn configure(&mut self) -> Result<(), VideoError> {
        let s = self.session as VTSessionRef;
        // Realtime, low-latency, no reordering (⇒ no B-frames): IPPP output.
        set_session_bool(s, kVTCompressionPropertyKey_RealTime, true);
        set_session_bool(s, kVTCompressionPropertyKey_AllowFrameReordering, false);
        set_session_cfstr(
            s,
            kVTCompressionPropertyKey_ProfileLevel,
            kVTProfileLevel_H264_High_AutoLevel,
        );
        set_session_i32(
            s,
            kVTCompressionPropertyKey_ExpectedFrameRate,
            self.config.fps.max(1) as i32,
        );
        if self.config.keyframe_interval > 0 {
            set_session_i32(
                s,
                kVTCompressionPropertyKey_MaxKeyFrameInterval,
                self.config.keyframe_interval as i32,
            );
        }

        // Signal BT.709 limited range (contract C1). VideoToolbox performs any
        // RGB→YCbCr conversion under these coefficients, so signaled == actual.
        set_session_cfstr(
            s,
            kVTCompressionPropertyKey_ColorPrimaries,
            kCVImageBufferColorPrimaries_ITU_R_709_2,
        );
        set_session_cfstr(
            s,
            kVTCompressionPropertyKey_TransferFunction,
            kCVImageBufferTransferFunction_ITU_R_709_2,
        );
        set_session_cfstr(
            s,
            kVTCompressionPropertyKey_YCbCrMatrix,
            kCVImageBufferYCbCrMatrix_ITU_R_709_2,
        );

        self.apply_bitrate(self.config.bitrate_kbps)?;

        // Best-effort warm-up; not fatal if it returns non-zero.
        let _ = VTCompressionSessionPrepareToEncodeFrames(self.session);
        Ok(())
    }

    /// Apply `AverageBitRate` plus a `DataRateLimits` hard cap at ≈1.5× the
    /// target over one second (CBR-ish capped VBR).
    unsafe fn apply_bitrate(&self, bitrate_kbps: u32) -> Result<(), VideoError> {
        let s = self.session as VTSessionRef;
        let bps = (bitrate_kbps.max(1) as i64) * 1000;
        let ret = set_session_i32(
            s,
            kVTCompressionPropertyKey_AverageBitRate,
            bps.min(i32::MAX as i64) as i32,
        );
        if ret != 0 {
            return Err(VideoError::EncoderInit(format!(
                "set AverageBitRate failed: OSStatus {ret}"
            )));
        }
        // DataRateLimits = [ max_bytes (SInt64), 1 second (SInt32) ]. Cap at
        // 1.5× the average bitrate to keep bursts bounded for realtime.
        let max_bytes_per_sec = bps.saturating_mul(3) / 2 / 8;
        let bytes = cfnum_i64(max_bytes_per_sec);
        let secs = cfnum_i32(1);
        let vals: [*const c_void; 2] = [bytes, secs];
        let arr = CFArrayCreate(
            ptr::null(),
            vals.as_ptr(),
            2,
            &kCFTypeArrayCallBacks as *const c_void,
        );
        if !arr.is_null() {
            VTSessionSetProperty(s, kVTCompressionPropertyKey_DataRateLimits, arr);
        }
        cf_release(arr);
        cf_release(bytes);
        cf_release(secs);
        Ok(())
    }

    unsafe fn query_hardware(&self) -> bool {
        let mut value: CFTypeRef = ptr::null();
        let ret = VTSessionCopyProperty(
            self.session as VTSessionRef,
            kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
            ptr::null(),
            &mut value,
        );
        if ret != 0 || value.is_null() {
            // Property unavailable ⇒ unknown; "unknown is not hardware" (C3).
            return false;
        }
        let hw = CFBooleanGetValue(value) != 0;
        cf_release(value);
        hw
    }

    /// Build and fill a `CVPixelBuffer` from the caller's tightly-packed buffer.
    /// IOSurface-backed so a hardware encoder can consume it. Row copies honor
    /// the pixel buffer's own `bytesPerRow`, which may be padded.
    unsafe fn make_pixel_buffer(&self, data: &[u8]) -> Result<CVPixelBufferRef, VideoError> {
        let w = self.config.width as usize;
        let h = self.config.height as usize;

        let attrs = new_cf_dict();
        if attrs.is_null() {
            return Err(VideoError::EncodeFailed(
                "CFDictionaryCreateMutable (pixel buffer attrs) failed".into(),
            ));
        }
        let iosurface = new_cf_dict();
        CFDictionarySetValue(
            attrs,
            kCVPixelBufferIOSurfacePropertiesKey as *const c_void,
            iosurface as *const c_void,
        );
        cf_release(iosurface as *const c_void);

        let mut pb: CVPixelBufferRef = ptr::null_mut();
        let cv = CVPixelBufferCreate(
            ptr::null(),
            w,
            h,
            cv_pixel_format(self.config.pixel_format),
            attrs,
            &mut pb,
        );
        cf_release(attrs as *const c_void);
        if cv != 0 || pb.is_null() {
            return Err(VideoError::EncodeFailed(format!(
                "CVPixelBufferCreate failed: CVReturn {cv}"
            )));
        }

        if CVPixelBufferLockBaseAddress(pb, 0) != 0 {
            cf_release(pb as *const c_void);
            return Err(VideoError::EncodeFailed(
                "CVPixelBufferLockBaseAddress failed".into(),
            ));
        }

        match self.config.pixel_format {
            PixelFormat::Bgra | PixelFormat::Rgba => {
                let dst = CVPixelBufferGetBaseAddress(pb) as *mut u8;
                let dst_stride = CVPixelBufferGetBytesPerRow(pb);
                let src_stride = w * 4;
                for row in 0..h {
                    ptr::copy_nonoverlapping(
                        data.as_ptr().add(row * src_stride),
                        dst.add(row * dst_stride),
                        src_stride,
                    );
                }
            }
            PixelFormat::I420 => {
                let y_size = w * h;
                let uv_w = w / 2;
                let uv_h = h / 2;
                let uv_size = uv_w * uv_h;
                // Planes: 0 = Y, 1 = Cb(U), 2 = Cr(V), matching our I420 layout.
                let planes: [(usize, usize, usize, usize); 3] = [
                    (0, 0, w, h),
                    (1, y_size, uv_w, uv_h),
                    (2, y_size + uv_size, uv_w, uv_h),
                ];
                for (plane, src_off, plane_w, plane_h) in planes {
                    let dst = CVPixelBufferGetBaseAddressOfPlane(pb, plane) as *mut u8;
                    let dst_stride = CVPixelBufferGetBytesPerRowOfPlane(pb, plane);
                    for row in 0..plane_h {
                        ptr::copy_nonoverlapping(
                            data.as_ptr().add(src_off + row * plane_w),
                            dst.add(row * dst_stride),
                            plane_w,
                        );
                    }
                }
            }
        }

        CVPixelBufferUnlockBaseAddress(pb, 0);
        Ok(pb)
    }
}

impl VideoEncoder for VideoToolboxH264Encoder {
    fn encode(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        let expected = self
            .config
            .pixel_format
            .frame_size(self.config.width, self.config.height);
        if data.len() != expected {
            return Err(VideoError::FrameSizeMismatch {
                expected,
                actual: data.len(),
            });
        }

        unsafe {
            let pb = self.make_pixel_buffer(data)?;

            let frame_props = if force_keyframe {
                let dict = new_cf_dict();
                if !dict.is_null() {
                    CFDictionarySetValue(
                        dict,
                        kVTEncodeFrameOptionKey_ForceKeyFrame as *const c_void,
                        kCFBooleanTrue as *const c_void,
                    );
                }
                dict
            } else {
                ptr::null_mut()
            };

            let fps = self.config.fps.max(1) as i32;
            let pts_time = CMTimeMake(pts, fps);
            let dur_time = CMTimeMake(1, fps);
            let status = VTCompressionSessionEncodeFrame(
                self.session,
                pb,
                pts_time,
                dur_time,
                frame_props,
                ptr::null_mut(),
                ptr::null_mut(),
            );
            cf_release(pb as *const c_void);
            cf_release(frame_props as *const c_void);
            if status != 0 {
                return Err(VideoError::EncodeFailed(format!(
                    "VTCompressionSessionEncodeFrame failed: OSStatus {status}"
                )));
            }
        }

        let mut guard = self.output.lock().unwrap();
        if let Some(err) = guard.error.take() {
            return Err(VideoError::EncodeFailed(err));
        }
        Ok(std::mem::take(&mut guard.frames))
    }

    fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        unsafe {
            let ret = VTCompressionSessionCompleteFrames(self.session, CMTime::INVALID);
            if ret != 0 {
                return Err(VideoError::EncodeFailed(format!(
                    "VTCompressionSessionCompleteFrames failed: OSStatus {ret}"
                )));
            }
        }
        let mut guard = self.output.lock().unwrap();
        if let Some(err) = guard.error.take() {
            return Err(VideoError::EncodeFailed(err));
        }
        Ok(std::mem::take(&mut guard.frames))
    }

    fn config(&self) -> &EncoderConfig {
        &self.config
    }

    fn codec(&self) -> VideoCodec {
        VideoCodec::H264
    }

    fn backend_name(&self) -> &'static str {
        if self.hardware {
            "videotoolbox-h264-hw"
        } else {
            "videotoolbox-h264-sw"
        }
    }

    fn is_hardware_accelerated(&self) -> bool {
        self.hardware
    }

    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<bool, VideoError> {
        let new_kbps = bitrate_kbps.max(1);
        if self.config.bitrate_kbps == new_kbps {
            return Ok(true);
        }
        // VideoToolbox supports a live AverageBitRate reconfigure in place — no
        // session rebuild, no re-probe. Apply it and report success.
        unsafe { self.apply_bitrate(new_kbps)? };
        self.config.bitrate_kbps = new_kbps;
        Ok(true)
    }
}

impl Drop for VideoToolboxH264Encoder {
    fn drop(&mut self) {
        unsafe {
            if !self.session.is_null() {
                // Invalidate first so no further callback can touch `output`,
                // then release the session; the Box drops last.
                VTCompressionSessionInvalidate(self.session);
                cf_release(self.session as *const c_void);
                self.session = ptr::null_mut();
            }
        }
    }
}

/// Compression output callback: converts one AVCC sample buffer to an Annex-B
/// [`EncodedFrame`] and pushes it onto the shared output. Never unwinds across
/// the FFI boundary.
unsafe extern "C" fn compression_output_callback(
    output_callback_refcon: *mut c_void,
    _source_frame_refcon: *mut c_void,
    status: OSStatus,
    _info_flags: VTEncodeInfoFlags,
    sample_buffer: CMSampleBufferRef,
) {
    if output_callback_refcon.is_null() {
        return;
    }
    let shared = &*(output_callback_refcon as *const Mutex<EncoderOutput>);
    let (width, height) = match shared.lock() {
        Ok(g) => (g.width, g.height),
        Err(_) => return,
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if status != 0 {
            return Err(format!("encode callback status {status}"));
        }
        if sample_buffer.is_null() {
            // Dropped frame (e.g. rate control): not an error, nothing to emit.
            return Ok(None);
        }
        let (data, is_keyframe, pts) = sample_buffer_to_annexb(sample_buffer)?;
        Ok(Some(EncodedFrame {
            data,
            codec: VideoCodec::H264,
            pts,
            is_keyframe,
            layer: None,
            width,
            height,
            colorspace: ColorSpace::Bt709,
        }))
    }));

    if let Ok(mut guard) = shared.lock() {
        match result {
            Ok(Ok(Some(frame))) => guard.frames.push(frame),
            Ok(Ok(None)) => {}
            Ok(Err(msg)) => guard.error.get_or_insert(msg),
            Err(_) => guard
                .error
                .get_or_insert_with(|| "encode callback panicked".into()),
        };
    }
}

/// Convert a VideoToolbox H.264 sample buffer (AVCC length-prefixed) to
/// Annex-B, prepending the format description's SPS/PPS on keyframes. Returns
/// `(annex_b_bytes, is_keyframe, pts)`.
unsafe fn sample_buffer_to_annexb(sbuf: CMSampleBufferRef) -> Result<(Vec<u8>, bool, i64), String> {
    let is_keyframe = sample_is_keyframe(sbuf);
    let pts = CMSampleBufferGetPresentationTimeStamp(sbuf).value;

    let fmt = CMSampleBufferGetFormatDescription(sbuf);
    // NAL length-prefix size (usually 4), read from the format description.
    let mut nal_len_size: c_int = 4;
    let mut param_count: usize = 0;
    if !fmt.is_null() {
        let _ = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            fmt,
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut param_count,
            &mut nal_len_size,
        );
    }
    if !(1..=4).contains(&nal_len_size) {
        nal_len_size = 4;
    }

    let mut out = Vec::new();

    // On keyframes prepend every parameter set (SPS/PPS) as Annex-B NALs; the
    // sample buffer itself carries only the slice NALs.
    if is_keyframe && !fmt.is_null() {
        for i in 0..param_count {
            let mut ps_ptr: *const u8 = ptr::null();
            let mut ps_size: usize = 0;
            let ret = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fmt,
                i,
                &mut ps_ptr,
                &mut ps_size,
                ptr::null_mut(),
                ptr::null_mut(),
            );
            if ret == 0 && !ps_ptr.is_null() && ps_size > 0 {
                out.extend_from_slice(&[0, 0, 0, 1]);
                out.extend_from_slice(std::slice::from_raw_parts(ps_ptr, ps_size));
            }
        }
    }

    // Copy the AVCC payload out contiguously (handles non-contiguous blocks).
    let bbuf = CMSampleBufferGetDataBuffer(sbuf);
    if bbuf.is_null() {
        return Err("sample buffer has no data buffer".into());
    }
    let total = CMBlockBufferGetDataLength(bbuf);
    let mut avcc = vec![0u8; total];
    let ret = CMBlockBufferCopyDataBytes(bbuf, 0, total, avcc.as_mut_ptr() as *mut c_void);
    if ret != 0 {
        return Err(format!("CMBlockBufferCopyDataBytes failed: OSStatus {ret}"));
    }

    // Walk length-prefixed NALs, replacing each prefix with a start code.
    let n = nal_len_size as usize;
    let mut off = 0usize;
    while off + n <= avcc.len() {
        let mut nal_len: usize = 0;
        for j in 0..n {
            nal_len = (nal_len << 8) | avcc[off + j] as usize;
        }
        off += n;
        if nal_len == 0 || off + nal_len > avcc.len() {
            break;
        }
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&avcc[off..off + nal_len]);
        off += nal_len;
    }

    Ok((out, is_keyframe, pts))
}

/// Keyframe iff the first sample-attachments dict has no `NotSync = true`.
unsafe fn sample_is_keyframe(sbuf: CMSampleBufferRef) -> bool {
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sbuf, 0);
    if attachments.is_null() || CFArrayGetCount(attachments) == 0 {
        // No attachments ⇒ treat as sync (keyframe).
        return true;
    }
    let dict = CFArrayGetValueAtIndex(attachments, 0) as CFDictionaryRef;
    if dict.is_null() {
        return true;
    }
    // kCMSampleAttachmentKey_NotSync — declared inline to avoid one more static.
    let not_sync = CFDictionaryGetValue(dict, not_sync_key());
    if not_sync.is_null() {
        return true;
    }
    // Present: keyframe only when NotSync is false.
    CFBooleanGetValue(not_sync as CFBooleanRef) == 0
}

/// `kCMSampleAttachmentKey_NotSync` lives in CoreMedia; fetch via a dedicated
/// extern static.
unsafe fn not_sync_key() -> *const c_void {
    kCMSampleAttachmentKey_NotSync as *const c_void
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    static kCMSampleAttachmentKey_NotSync: CFStringRef;
}

// ── Decoder ──────────────────────────────────────────────────────────

/// Largest decoded dimension / pixel count we accept — same 8K bound as the
/// other decoders. `width`/`height` come from remote, untrusted bitstreams.
const MAX_DECODE_DIMENSION: u32 = 8192;
const MAX_DECODE_PIXELS: u32 = 7680 * 4320;

/// Output produced by the decompression output callback. The callback fills
/// exactly one of `frames` / `handles` per decoded image, chosen by `mode`
/// (spec §3.2): CPU mode copies the pixel buffer to a tightly-packed I420
/// [`DecodedFrame`]; GPU mode retains the `CVPixelBuffer` as a GPU-resident
/// [`CvPixelBufferFrame`] with no CPU copy.
struct DecoderOutput {
    frames: Vec<DecodedFrame>,
    handles: Vec<CvPixelBufferFrame>,
    error: Option<String>,
    mode: DecodeOutput,
}

/// H.264 decoder backed by a `VTDecompressionSession`.
///
/// The format description and session are (re)built from the SPS/PPS carried in
/// each keyframe, so the decoder needs no configuration up front — a fresh
/// decoder just requires a keyframe first, exactly like [`Vp9Decoder`].
///
/// `mode` fixes where decoded frames land, once at construction (spec §3.2),
/// exactly like [`LavcDecoder`](crate::video::lavc::LavcDecoder): [`Cpu`] decodes
/// to planar I420 for the CPU API; [`Gpu`] decodes to an NV12 `CVPixelBuffer`
/// retained as a [`DecodedFrameHandle::CvPixelBuffer`] for the macOS native
/// surface (`AVSampleBufferDisplayLayer`), never touching system memory.
///
/// [`Cpu`]: DecodeOutput::Cpu
/// [`Gpu`]: DecodeOutput::Gpu
pub struct VideoToolboxH264Decoder {
    config: DecoderConfig,
    session: VTDecompressionSessionRef,
    format_desc: CMFormatDescriptionRef,
    output: Box<Mutex<DecoderOutput>>,
    /// Where decoded frames land, fixed at construction (spec §3.2). Mirrored
    /// into `output`'s `mode` so the decompression callback can branch.
    mode: DecodeOutput,
    /// Cached parameter sets so the session is only rebuilt when they change.
    sps: Vec<u8>,
    pps: Vec<u8>,
    needs_keyframe: bool,
}

// Safety: raw pointers are touched only through `&mut self`; the callback
// synchronizes on the `Mutex`.
unsafe impl Send for VideoToolboxH264Decoder {}

impl VideoToolboxH264Decoder {
    /// Create a decoder with CPU (I420) output — the back-compatible constructor
    /// used by the capability probe and the CPU decode pool. Equivalent to
    /// `new_with_output(config, DecodeOutput::Cpu)`.
    pub fn new(config: DecoderConfig) -> Result<Self, VideoError> {
        Self::new_with_output(config, DecodeOutput::Cpu)
    }

    /// Create a decoder whose output placement is fixed to `mode` (spec §3.2),
    /// mirroring [`LavcDecoder::new_with_output`](crate::video::lavc::LavcDecoder::new_with_output).
    /// In [`DecodeOutput::Gpu`] mode the session decodes to an NV12
    /// `CVPixelBuffer` presented zero-copy by the native surface; the CPU
    /// [`decode`](VideoDecoder::decode) API is then unavailable (a loud error),
    /// and frames are drained through [`decode_to_handles`](VideoDecoder::decode_to_handles).
    pub fn new_with_output(config: DecoderConfig, mode: DecodeOutput) -> Result<Self, VideoError> {
        Ok(Self {
            config,
            session: ptr::null_mut(),
            format_desc: ptr::null_mut(),
            output: Box::new(Mutex::new(DecoderOutput {
                frames: Vec::new(),
                handles: Vec::new(),
                error: None,
                mode,
            })),
            mode,
            sps: Vec::new(),
            pps: Vec::new(),
            needs_keyframe: true,
        })
    }

    pub fn is_hardware_accelerated(&self) -> bool {
        // VideoToolbox H.264 decode is hardware on all Macs this project
        // targets; there is no per-session "using hardware" decode query, so we
        // report hardware (the honest default for the platform's HW decoder).
        true
    }

    pub fn backend_name(&self) -> &'static str {
        "videotoolbox-h264-decode"
    }

    /// (Re)build the format description and decompression session from the SPS
    /// and PPS extracted from a keyframe, if they differ from the cached ones.
    unsafe fn ensure_session(&mut self, sps: &[u8], pps: &[u8]) -> Result<(), VideoError> {
        if !self.session.is_null() && self.sps == sps && self.pps == pps {
            return Ok(());
        }
        self.teardown_session();

        let ps_ptrs: [*const u8; 2] = [sps.as_ptr(), pps.as_ptr()];
        let ps_sizes: [usize; 2] = [sps.len(), pps.len()];
        let mut fmt: CMFormatDescriptionRef = ptr::null_mut();
        let ret = CMVideoFormatDescriptionCreateFromH264ParameterSets(
            ptr::null(),
            2,
            ps_ptrs.as_ptr(),
            ps_sizes.as_ptr(),
            4,
            &mut fmt,
        );
        if ret != 0 || fmt.is_null() {
            return Err(VideoError::DecoderInit(format!(
                "CMVideoFormatDescriptionCreateFromH264ParameterSets failed: OSStatus {ret}"
            )));
        }
        self.format_desc = fmt;

        // Destination attributes: IOSurface-backed. CPU mode requests planar
        // I420 (copied to a packed I420 frame); GPU mode requests NV12 — the
        // hardware-native format an `AVSampleBufferDisplayLayer` presents
        // zero-copy from the retained buffer (spec §3.2/§3.5).
        let dst_format = match self.mode {
            DecodeOutput::Cpu => kCVPixelFormatType_420YpCbCr8Planar,
            DecodeOutput::Gpu => kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        };
        let attrs = new_cf_dict();
        if attrs.is_null() {
            return Err(VideoError::DecoderInit(
                "CFDictionaryCreateMutable (decode attrs) failed".into(),
            ));
        }
        let pf = cfnum_i32(dst_format as i32);
        CFDictionarySetValue(
            attrs,
            kCVPixelBufferPixelFormatTypeKey as *const c_void,
            pf as *const c_void,
        );
        cf_release(pf);
        let iosurface = new_cf_dict();
        CFDictionarySetValue(
            attrs,
            kCVPixelBufferIOSurfacePropertiesKey as *const c_void,
            iosurface as *const c_void,
        );
        cf_release(iosurface as *const c_void);

        let refcon = &*self.output as *const Mutex<DecoderOutput> as *mut c_void;
        let record = VTDecompressionOutputCallbackRecord {
            decompressionOutputCallback: Some(decompression_output_callback),
            decompressionOutputRefCon: refcon,
        };

        let mut session: VTDecompressionSessionRef = ptr::null_mut();
        let ret = VTDecompressionSessionCreate(
            ptr::null(),
            self.format_desc,
            ptr::null(),
            attrs,
            &record,
            &mut session,
        );
        cf_release(attrs as *const c_void);
        if ret != 0 || session.is_null() {
            return Err(VideoError::DecoderInit(format!(
                "VTDecompressionSessionCreate failed: OSStatus {ret}"
            )));
        }
        self.session = session;
        self.sps = sps.to_vec();
        self.pps = pps.to_vec();
        Ok(())
    }

    unsafe fn teardown_session(&mut self) {
        if !self.session.is_null() {
            VTDecompressionSessionInvalidate(self.session);
            cf_release(self.session as *const c_void);
            self.session = ptr::null_mut();
        }
        if !self.format_desc.is_null() {
            cf_release(self.format_desc as *const c_void);
            self.format_desc = ptr::null_mut();
        }
    }

    /// Feed one encoded frame to the decompression session (shared by the CPU
    /// [`decode`](VideoDecoder::decode) and GPU [`decode_gpu`](Self::decode_gpu)
    /// paths). On success the decompression output callback has appended to the
    /// mode's output vector (`frames` for CPU, `handles` for GPU); the caller
    /// drains it. A parameter-set-only access unit (no VCL NALs) is a valid
    /// no-op. Sets `needs_keyframe` on any failure so the pipeline re-primes.
    fn feed_frame(&mut self, frame: &EncodedFrame) -> Result<(), VideoError> {
        if self.needs_keyframe && !frame.is_keyframe {
            return Err(VideoError::KeyframeRequired);
        }

        // Split Annex-B into NALs; separate parameter sets (rebuild the session)
        // from VCL NALs (repacked to AVCC for the sample buffer).
        let nals = split_annex_b(&frame.data);
        let mut sps: Option<&[u8]> = None;
        let mut pps: Option<&[u8]> = None;
        let mut avcc: Vec<u8> = Vec::with_capacity(frame.data.len() + 16);
        for nal in &nals {
            if nal.is_empty() {
                continue;
            }
            let nal_type = nal[0] & 0x1F;
            match nal_type {
                7 => sps = Some(nal),
                8 => pps = Some(nal),
                _ => {
                    // 4-byte big-endian length prefix (AVCC).
                    let len = nal.len() as u32;
                    avcc.extend_from_slice(&len.to_be_bytes());
                    avcc.extend_from_slice(nal);
                }
            }
        }

        unsafe {
            if let (Some(sps), Some(pps)) = (sps, pps) {
                self.ensure_session(sps, pps)?;
            }
            if self.session.is_null() {
                // Keyframe without parameter sets: cannot build a session.
                self.needs_keyframe = true;
                return Err(VideoError::DecodeFailed(
                    "H.264 keyframe carried no SPS/PPS; cannot initialize VideoToolbox decoder"
                        .into(),
                ));
            }

            if frame.is_keyframe {
                self.needs_keyframe = false;
            }
            if avcc.is_empty() {
                // Parameter-set-only access unit (no slices): nothing to decode.
                return Ok(());
            }

            let sbuf = match self.make_sample_buffer(&avcc, frame.pts) {
                Ok(s) => s,
                Err(e) => {
                    self.needs_keyframe = true;
                    return Err(e);
                }
            };

            let mut info: VTDecodeInfoFlags = 0;
            let ret = VTDecompressionSessionDecodeFrame(
                self.session,
                sbuf,
                0, // synchronous
                ptr::null_mut(),
                &mut info,
            );
            let _ = VTDecompressionSessionWaitForAsynchronousFrames(self.session);
            cf_release(sbuf as *const c_void);
            if ret != 0 {
                self.needs_keyframe = true;
                return Err(VideoError::DecodeFailed(format!(
                    "VTDecompressionSessionDecodeFrame failed: OSStatus {ret}"
                )));
            }
        }
        Ok(())
    }

    /// Decode into GPU-resident [`DecodedFrameHandle::CvPixelBuffer`] handles
    /// (spec §3.2/§3.5). Only reached when `self.mode == DecodeOutput::Gpu`; the
    /// decompression callback retained each decoded NV12 `CVPixelBuffer` without
    /// any CPU copy, so this just drains and wraps them.
    fn decode_gpu(&mut self, frame: &EncodedFrame) -> Result<Vec<DecodedFrameHandle>, VideoError> {
        self.feed_frame(frame)?;
        let mut guard = self.output.lock().unwrap();
        if let Some(err) = guard.error.take() {
            self.needs_keyframe = true;
            return Err(VideoError::DecodeFailed(err));
        }
        Ok(std::mem::take(&mut guard.handles)
            .into_iter()
            .map(DecodedFrameHandle::CvPixelBuffer)
            .collect())
    }
}

impl VideoDecoder for VideoToolboxH264Decoder {
    fn decode(&mut self, frame: &EncodedFrame) -> Result<Vec<DecodedFrame>, VideoError> {
        // The CPU decode API is only meaningful for a CPU-output decoder; a
        // GPU-output decoder was chosen once at construction for the native
        // surface and produces `CVPixelBuffer` handles via `decode_to_handles`.
        // Calling `decode` on it is a caller bug — a loud error, never a silent
        // empty result (spec §0/§3.2).
        if matches!(self.mode, DecodeOutput::Gpu) {
            return Err(VideoError::DecodeFailed(
                "VideoToolbox decoder constructed for GPU (CVPixelBuffer) output; use \
                 decode_to_handles (the CPU decode API is unavailable in this mode)"
                    .into(),
            ));
        }
        self.feed_frame(frame)?;
        let mut guard = self.output.lock().unwrap();
        if let Some(err) = guard.error.take() {
            self.needs_keyframe = true;
            return Err(VideoError::DecodeFailed(err));
        }
        Ok(std::mem::take(&mut guard.frames))
    }

    fn decode_to_handles(
        &mut self,
        frame: &EncodedFrame,
    ) -> Result<Vec<DecodedFrameHandle>, VideoError> {
        match self.mode {
            // CPU mode: decode to I420 and wrap as the software-floor handle,
            // exactly like the default trait behaviour and the lavc CPU path.
            DecodeOutput::Cpu => Ok(self
                .decode(frame)?
                .into_iter()
                .map(DecodedFrameHandle::cpu_i420_from)
                .collect()),
            // GPU mode: keep the decoded NV12 `CVPixelBuffer` on the GPU and hand
            // the native surface a retained handle (spec §3.2/§3.5).
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
            self.teardown_session();
        }
        // Drop any buffered output so a reset does not carry stale frames or
        // retained pixel buffers into the fresh stream.
        if let Ok(mut guard) = self.output.lock() {
            guard.frames.clear();
            guard.handles.clear();
            guard.error = None;
        }
        self.sps.clear();
        self.pps.clear();
        self.needs_keyframe = true;
        Ok(())
    }

    fn config(&self) -> &DecoderConfig {
        &self.config
    }
}

impl VideoToolboxH264Decoder {
    /// Wrap AVCC-formatted `avcc` bytes in a `CMSampleBuffer` carrying the
    /// current format description, ready for `VTDecompressionSessionDecodeFrame`.
    unsafe fn make_sample_buffer(
        &self,
        avcc: &[u8],
        pts: i64,
    ) -> Result<CMSampleBufferRef, VideoError> {
        let mut bbuf: CMBlockBufferRef = ptr::null_mut();
        let ret = CMBlockBufferCreateWithMemoryBlock(
            ptr::null(),
            ptr::null_mut(),
            avcc.len(),
            ptr::null(),
            ptr::null(),
            0,
            avcc.len(),
            kCMBlockBufferAssureMemoryNowFlag,
            &mut bbuf,
        );
        if ret != 0 || bbuf.is_null() {
            return Err(VideoError::DecodeFailed(format!(
                "CMBlockBufferCreateWithMemoryBlock failed: OSStatus {ret}"
            )));
        }
        let ret =
            CMBlockBufferReplaceDataBytes(avcc.as_ptr() as *const c_void, bbuf, 0, avcc.len());
        if ret != 0 {
            cf_release(bbuf as *const c_void);
            return Err(VideoError::DecodeFailed(format!(
                "CMBlockBufferReplaceDataBytes failed: OSStatus {ret}"
            )));
        }

        let timing = CMSampleTimingInfo {
            duration: CMTime::INVALID,
            presentationTimeStamp: CMTimeMake(pts, 90_000),
            decodeTimeStamp: CMTime::INVALID,
        };
        let sizes: [usize; 1] = [avcc.len()];
        let mut sbuf: CMSampleBufferRef = ptr::null_mut();
        let ret = CMSampleBufferCreateReady(
            ptr::null(),
            bbuf,
            self.format_desc,
            1,
            1,
            &timing,
            1,
            sizes.as_ptr(),
            &mut sbuf,
        );
        cf_release(bbuf as *const c_void);
        if ret != 0 || sbuf.is_null() {
            return Err(VideoError::DecodeFailed(format!(
                "CMSampleBufferCreateReady failed: OSStatus {ret}"
            )));
        }
        Ok(sbuf)
    }
}

impl Drop for VideoToolboxH264Decoder {
    fn drop(&mut self) {
        unsafe {
            self.teardown_session();
        }
    }
}

/// One decoded image the callback routes to the mode's output vector: a CPU
/// I420 copy or a retained GPU-resident `CVPixelBuffer` handle (spec §3.2).
enum CallbackFrame {
    Cpu(DecodedFrame),
    Gpu(CvPixelBufferFrame),
}

/// Decompression output callback: routes one decoded image into the shared
/// output per the decoder's fixed mode — a CPU I420 copy (`Cpu`) or a retained
/// `CVPixelBuffer` handle with no CPU copy (`Gpu`). Never unwinds across the FFI
/// boundary.
unsafe extern "C" fn decompression_output_callback(
    decompression_output_refcon: *mut c_void,
    _source_frame_refcon: *mut c_void,
    status: OSStatus,
    _info_flags: VTDecodeInfoFlags,
    image_buffer: CVImageBufferRef,
    presentation_timestamp: CMTime,
    _presentation_duration: CMTime,
) {
    if decompression_output_refcon.is_null() {
        return;
    }
    let shared = &*(decompression_output_refcon as *const Mutex<DecoderOutput>);

    // The mode is fixed at construction; read it before doing the work. The
    // session is driven synchronously (decode flags = 0), so this callback runs
    // on the decode thread and the two short locks never contend.
    let mode = match shared.lock() {
        Ok(guard) => guard.mode,
        Err(_) => return,
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if status != 0 {
            return Err(format!("decode callback status {status}"));
        }
        if image_buffer.is_null() {
            return Ok(None);
        }
        match mode {
            DecodeOutput::Cpu => image_buffer_to_i420(image_buffer, presentation_timestamp.value)
                .map(|f| Some(CallbackFrame::Cpu(f))),
            DecodeOutput::Gpu => {
                retain_cv_handle(image_buffer).map(|h| Some(CallbackFrame::Gpu(h)))
            }
        }
    }));

    if let Ok(mut guard) = shared.lock() {
        match result {
            Ok(Ok(Some(CallbackFrame::Cpu(frame)))) => guard.frames.push(frame),
            Ok(Ok(Some(CallbackFrame::Gpu(handle)))) => guard.handles.push(handle),
            Ok(Ok(None)) => {}
            Ok(Err(msg)) => {
                guard.error.get_or_insert(msg);
            }
            Err(_) => {
                guard
                    .error
                    .get_or_insert_with(|| "decode callback panicked".into());
            }
        }
    }
}

/// Retain a decoded `CVPixelBuffer` as a GPU-resident handle (spec §3.2/§3.5),
/// with no copy to system memory. Bounds the reported dimensions like the CPU
/// path since they derive from a remote bitstream. `CVImageBufferRef` and
/// `CVPixelBufferRef` are the same opaque handle for a pixel-buffer image.
unsafe fn retain_cv_handle(pb: CVImageBufferRef) -> Result<CvPixelBufferFrame, String> {
    let width = CVPixelBufferGetWidth(pb) as u32;
    let height = CVPixelBufferGetHeight(pb) as u32;
    let within = width <= MAX_DECODE_DIMENSION
        && height <= MAX_DECODE_DIMENSION
        && width
            .checked_mul(height)
            .is_some_and(|px| px <= MAX_DECODE_PIXELS);
    if !within {
        return Err(format!(
            "decoded frame resolution out of bounds: {width}x{height}"
        ));
    }
    let colorspace = image_buffer_colorspace(pb);
    Ok(CvPixelBufferFrame::retain(pb, width, height, colorspace))
}

/// Copy a planar-I420 `CVPixelBuffer` into a tightly-packed I420 [`DecodedFrame`].
unsafe fn image_buffer_to_i420(pb: CVImageBufferRef, pts: i64) -> Result<DecodedFrame, String> {
    let width = CVPixelBufferGetWidth(pb) as u32;
    let height = CVPixelBufferGetHeight(pb) as u32;
    let within = width <= MAX_DECODE_DIMENSION
        && height <= MAX_DECODE_DIMENSION
        && width
            .checked_mul(height)
            .is_some_and(|px| px <= MAX_DECODE_PIXELS);
    if !within {
        return Err(format!(
            "decoded frame resolution out of bounds: {width}x{height}"
        ));
    }
    let colorspace = image_buffer_colorspace(pb);

    if CVPixelBufferLockBaseAddress(pb, 1 /* read-only */) != 0 {
        return Err("CVPixelBufferLockBaseAddress (decode) failed".into());
    }

    let w = width as usize;
    let h = height as usize;
    let uv_w = w / 2;
    let uv_h = h / 2;
    let y_size = w * h;
    let uv_size = uv_w * uv_h;
    let mut out = vec![0u8; y_size + 2 * uv_size];

    let planes: [(usize, usize, usize, usize); 3] = [
        (0, 0, w, h),
        (1, y_size, uv_w, uv_h),
        (2, y_size + uv_size, uv_w, uv_h),
    ];
    for (plane, dst_off, plane_w, plane_h) in planes {
        let src = CVPixelBufferGetBaseAddressOfPlane(pb, plane) as *const u8;
        let src_stride = CVPixelBufferGetBytesPerRowOfPlane(pb, plane);
        // Guard against a decoder that emitted a plane smaller than expected.
        let avail_w = CVPixelBufferGetWidthOfPlane(pb, plane).min(plane_w);
        let avail_h = CVPixelBufferGetHeightOfPlane(pb, plane).min(plane_h);
        if src.is_null() {
            CVPixelBufferUnlockBaseAddress(pb, 1);
            return Err("decoded plane base address is null".into());
        }
        for row in 0..avail_h {
            ptr::copy_nonoverlapping(
                src.add(row * src_stride),
                out.as_mut_ptr().add(dst_off + row * plane_w),
                avail_w,
            );
        }
    }

    CVPixelBufferUnlockBaseAddress(pb, 1);

    Ok(DecodedFrame {
        data: out,
        pixel_format: PixelFormat::I420,
        width,
        height,
        pts,
        colorspace,
    })
}

/// Map the pixel buffer's `YCbCrMatrix` attachment to our [`ColorSpace`]
/// (contract C1). Unspecified/709 ⇒ BT.709 (the default); the two SD matrices
/// map to BT.601 so a genuinely 601 source is reported honestly.
unsafe fn image_buffer_colorspace(pb: CVImageBufferRef) -> ColorSpace {
    let matrix = CVBufferGetAttachment(pb, kCVImageBufferYCbCrMatrixKey, ptr::null_mut());
    if matrix.is_null() {
        return ColorSpace::Bt709;
    }
    if CFEqual(matrix, kCVImageBufferYCbCrMatrix_ITU_R_601_4) != 0
        || CFEqual(matrix, kCVImageBufferYCbCrMatrix_SMPTE_240M_1995) != 0
    {
        ColorSpace::Bt601
    } else {
        ColorSpace::Bt709
    }
}

/// Split an Annex-B bitstream into NAL units (start codes stripped). Handles
/// both 3- and 4-byte start codes; a trailing `00` before the next `00 00 01`
/// (the 4-byte form) is dropped from the preceding NAL's tail.
fn split_annex_b(data: &[u8]) -> Vec<&[u8]> {
    let mut nals = Vec::new();
    // Start of the first NAL payload, after the leading start code.
    let mut start = match find_start_code(data, 0) {
        Some((pos, len)) => pos + len,
        None => return nals,
    };
    let mut i = start;
    while let Some((pos, len)) = find_start_code(data, i) {
        // `pos` is the `00 00 01` triplet; a preceding `00` belongs to the
        // 4-byte start code, so trim it off this NAL's tail.
        let mut end = pos;
        if end > start && data[end - 1] == 0 {
            end -= 1;
        }
        if end > start {
            nals.push(&data[start..end]);
        }
        i = pos + len;
        start = i;
    }
    if start < data.len() {
        nals.push(&data[start..]);
    }
    nals
}

/// Find the next `00 00 01` start-code triplet at or after `from`, returning its
/// position and length (always the 3-byte triplet; any extra leading `00` of a
/// 4-byte start code is handled by the caller).
fn find_start_code(data: &[u8], from: usize) -> Option<(usize, usize)> {
    let len = data.len();
    let mut i = from;
    while i + 3 <= len {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            return Some((i, 3));
        }
        i += 1;
    }
    None
}

// ── Capability probing ───────────────────────────────────────────────

/// Result of probing the VideoToolbox H.264 encoder.
#[derive(Debug, Clone, Copy)]
pub struct VideoToolboxEncodeProbe {
    /// Whether VideoToolbox selected a hardware encoder.
    pub hardware_accelerated: bool,
}

/// Probe the VideoToolbox H.264 encoder by constructing a session and encoding
/// one black keyframe. Returns `None` if the session cannot be built or emits no
/// packet (so `encode: true` genuinely means it works on this machine).
pub fn probe_h264_encoder() -> Option<VideoToolboxEncodeProbe> {
    let config = EncoderConfig {
        width: 1280,
        height: 720,
        fps: 30,
        bitrate_kbps: 4_000,
        pixel_format: PixelFormat::Bgra,
        keyframe_interval: 30,
        content_hint: crate::video::VideoContentHint::Default,
    };
    let mut enc = VideoToolboxH264Encoder::new(config).ok()?;
    let black = vec![0u8; PixelFormat::Bgra.frame_size(1280, 720)];
    let mut frames = enc.encode(0, &black, true).ok()?;
    if frames.is_empty() {
        frames = enc.flush().ok()?;
    }
    if frames.iter().any(|f| !f.data.is_empty()) {
        Some(VideoToolboxEncodeProbe {
            hardware_accelerated: enc.is_hardware(),
        })
    } else {
        None
    }
}

/// Produce one real hardware-encoded H.264 Annex-B keyframe (1280×720) for
/// verifying a remote decoder's support claim. `None` if no encoder is available.
pub fn generate_h264_probe_frame() -> Option<Vec<u8>> {
    let config = EncoderConfig {
        width: 1280,
        height: 720,
        fps: 30,
        bitrate_kbps: 4_000,
        pixel_format: PixelFormat::Bgra,
        keyframe_interval: 30,
        content_hint: crate::video::VideoContentHint::Default,
    };
    let mut enc = VideoToolboxH264Encoder::new(config).ok()?;
    let black = vec![0u8; PixelFormat::Bgra.frame_size(1280, 720)];
    let mut frames = enc.encode(0, &black, true).ok()?;
    if frames.is_empty() {
        frames = enc.flush().ok()?;
    }
    frames
        .into_iter()
        .find(|f| f.is_keyframe && !f.data.is_empty())
        .map(|f| f.data)
}

/// Whether VideoToolbox has a hardware H.264 decoder on this machine
/// (`VTIsHardwareDecodeSupported`). Backs the honest `decode_hardware`
/// advertisement (spec M3): `decode_hardware = true` only when the OS confirms
/// hardware decode, never merely because a session can be built in software.
pub fn supports_h264_hardware_decode() -> bool {
    unsafe { VTIsHardwareDecodeSupported(kCMVideoCodecType_H264) != 0 }
}

/// Whether VideoToolbox has a hardware AV1 decoder (Apple silicon M3+). Gates the
/// macOS AV1 native-surface route (spec §2/§3.5); AV1 VideoToolbox decode is
/// otherwise deferred ("AV1 on M3+ later"), so this is the probe a future AV1
/// `VtDecoder` and its capability advertisement key on.
pub fn supports_av1_hardware_decode() -> bool {
    unsafe { VTIsHardwareDecodeSupported(kCMVideoCodecType_AV1) != 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annex_b_split_roundtrip() {
        // Two NALs: SPS (type 7) and an IDR slice (type 5), 4-byte start codes.
        let mut stream = Vec::new();
        stream.extend_from_slice(&[0, 0, 0, 1, 0x67, 0xAA, 0xBB]);
        stream.extend_from_slice(&[0, 0, 0, 1, 0x65, 0x01, 0x02, 0x03]);
        let nals = split_annex_b(&stream);
        assert_eq!(nals.len(), 2);
        assert_eq!(nals[0][0] & 0x1F, 7);
        assert_eq!(nals[1][0] & 0x1F, 5);
        assert_eq!(nals[1], &[0x65, 0x01, 0x02, 0x03]);
    }

    #[test]
    fn annex_b_split_three_byte_start_codes() {
        let mut stream = Vec::new();
        stream.extend_from_slice(&[0, 0, 1, 0x68, 0x11]);
        stream.extend_from_slice(&[0, 0, 1, 0x41, 0x22, 0x33]);
        let nals = split_annex_b(&stream);
        assert_eq!(nals.len(), 2);
        assert_eq!(nals[0][0] & 0x1F, 8);
        assert_eq!(nals[1][0] & 0x1F, 1);
    }

    #[test]
    fn annex_b_split_empty() {
        assert!(split_annex_b(&[]).is_empty());
        assert!(split_annex_b(&[0, 0, 0, 1]).is_empty());
    }
}
