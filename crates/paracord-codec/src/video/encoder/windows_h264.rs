use super::{
    ColorSpace, EncodedFrame, EncoderConfig, PixelFormat, VideoCodec, VideoEncoder, VideoError,
};
use std::mem::ManuallyDrop;
use std::ptr::null_mut;
use std::sync::OnceLock;
use windows::core::Interface;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::Media::MediaFoundation::{
    eAVEncAV1VProfile_Main_420_8, eAVEncCommonRateControlMode_PeakConstrainedVBR,
    eAVEncH264VProfile_High, CODECAPI_AVEncCommonMaxBitRate, CODECAPI_AVEncCommonMeanBitRate,
    CODECAPI_AVEncCommonQualityVsSpeed, CODECAPI_AVEncCommonRateControlMode,
    CODECAPI_AVEncCommonRealTime, CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize,
    CODECAPI_AVEncVideoForceKeyFrame, CODECAPI_AVLowLatencyMode, ICodecAPI, IMFActivate,
    IMFMediaBuffer, IMFMediaType, IMFSample, IMFTransform, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFMediaType_Video, MFNominalRange_16_235, MFSampleExtension_CleanPoint,
    MFStartup, MFTEnumEx, MFVideoFormat_AV1, MFVideoFormat_H264, MFVideoFormat_H264_ES,
    MFVideoFormat_I420, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
    MFVideoTransferMatrix_BT709, MFSTARTUP_FULL, MFT_CATEGORY_VIDEO_ENCODER,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_INPUT_STATUS_ACCEPT_DATA,
    MFT_MESSAGE_COMMAND_DRAIN, MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES,
    MFT_REGISTER_TYPE_INFO, MF_E_TRANSFORM_NEED_MORE_INPUT, MF_LOW_LATENCY, MF_MT_AVG_BITRATE,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
    MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_VIDEO_NOMINAL_RANGE,
    MF_MT_YUV_MATRIX, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION,
};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::{
    VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_UI4,
};
// ── D3D11 texture (zero-copy) encode input, spec §7 (WGC→MFT) ─────────────
//
// These symbols back the GPU texture input path. They require the following
// features on the `windows` dependency in `crates/paracord-codec/Cargo.toml`
// (documented as an unowned contract in the change notes — the file is not
// owned by this agent):
//   Win32_Graphics_Direct3D11, Win32_Graphics_Dxgi_Common
// (`Win32_Media_MediaFoundation`, `Win32_System_Com` are already enabled.)
//
// COMPILE-UNVERIFIED: this whole file is `#[cfg(target_os = "windows")]` and
// cannot be built on the Linux CI toolchain; every use below is reviewed
// line-by-line against the windows-rs 0.61 API surface.
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Multithread, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::{
    IMF2DBuffer, IMFDXGIDeviceManager, MFCreateDXGIDeviceManager, MFCreateDXGISurfaceBuffer,
    MFVideoFormat_ARGB32, MFT_MESSAGE_SET_D3D_MANAGER, MF_SA_D3D11_AWARE,
};

const INPUT_STREAM_ID: u32 = 0;
const OUTPUT_STREAM_ID: u32 = 0;
const HNS_PER_SECOND: i64 = 10_000_000;

#[derive(Clone, Copy)]
struct EncoderTypeSelection {
    input_subtype: windows::core::GUID,
    output_subtype: windows::core::GUID,
    hardware: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MfCodecKind {
    H264,
    Av1,
}

impl MfCodecKind {
    fn codec(self) -> VideoCodec {
        match self {
            Self::H264 => VideoCodec::H264,
            Self::Av1 => VideoCodec::Av1,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::H264 => "H264",
            Self::Av1 => "AV1",
        }
    }

    fn output_candidates(self) -> &'static [windows::core::GUID] {
        match self {
            Self::H264 => &[MFVideoFormat_H264_ES, MFVideoFormat_H264],
            Self::Av1 => &[MFVideoFormat_AV1],
        }
    }
}

fn ensure_media_foundation() -> Result<(), VideoError> {
    static STARTUP: OnceLock<Result<(), String>> = OnceLock::new();
    let result = STARTUP.get_or_init(|| unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| format!("MFStartup failed: {err}"))
    });
    result
        .as_ref()
        .map(|_| ())
        .map_err(|err| VideoError::EncoderInit(err.clone()))
}

fn ensure_com_multithreaded() -> Result<(), VideoError> {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_ok() || hr == RPC_E_CHANGED_MODE {
            Ok(())
        } else {
            Err(VideoError::EncoderInit(format!(
                "CoInitializeEx failed: {hr}"
            )))
        }
    }
}

fn available_types_to_transform(activator: &IMFActivate) -> Result<IMFTransform, VideoError> {
    unsafe {
        activator
            .ActivateObject::<IMFTransform>()
            .map_err(|err| VideoError::EncoderInit(format!("ActivateObject failed: {err}")))
    }
}

fn enumerate_hardware_encoder(
    input_subtype: windows::core::GUID,
    output_subtype: windows::core::GUID,
) -> Result<Option<IMFTransform>, VideoError> {
    unsafe {
        let input_info = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: input_subtype,
        };
        let output_info = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: output_subtype,
        };
        let mut activates_ptr: *mut Option<IMFActivate> = null_mut();
        let mut count = 0u32;
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input_info),
            Some(&output_info),
            &mut activates_ptr,
            &mut count,
        )
        .map_err(|err| VideoError::EncoderInit(format!("MFTEnumEx failed: {err}")))?;

        let result = if activates_ptr.is_null() || count == 0 {
            None
        } else {
            let activates = std::slice::from_raw_parts(activates_ptr, count as usize);
            let mut transform = None;
            for activate in activates.iter().flatten() {
                if let Ok(instance) = available_types_to_transform(activate) {
                    transform = Some(instance);
                    break;
                }
            }
            transform
        };

        if !activates_ptr.is_null() {
            CoTaskMemFree(Some(activates_ptr.cast()));
        }

        Ok(result)
    }
}

fn packed_size(width: u32, height: u32) -> u32 {
    PixelFormat::I420.frame_size(width, height) as u32
}

fn pack_attribute_ratio(numerator: u32, denominator: u32) -> u64 {
    ((numerator as u64) << 32) | denominator as u64
}

fn set_common_media_type_fields(
    media_type: &IMFMediaType,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(), VideoError> {
    unsafe {
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| VideoError::EncoderInit(format!("Set major type failed: {err}")))?;
        media_type
            .SetUINT64(&MF_MT_FRAME_SIZE, pack_attribute_ratio(width, height))
            .map_err(|err| VideoError::EncoderInit(format!("Set frame size failed: {err}")))?;
        media_type
            .SetUINT64(&MF_MT_FRAME_RATE, pack_attribute_ratio(fps.max(1), 1))
            .map_err(|err| VideoError::EncoderInit(format!("Set frame rate failed: {err}")))?;
        media_type
            .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_attribute_ratio(1, 1))
            .map_err(|err| VideoError::EncoderInit(format!("Set aspect ratio failed: {err}")))?;
        media_type
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| VideoError::EncoderInit(format!("Set interlace mode failed: {err}")))?;
        // Signal BT.709 limited range (contract C1): the I420 the encoder
        // receives now carries 709 coefficients, so the MFT must be told the
        // input matrix and nominal range or it dequantizes/tags with the wrong
        // one. Applied to both input and output types. Best-effort — an MFT that
        // rejects these attributes still encodes, just without the explicit tag.
        let _ = media_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32);
        let _ = media_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32);
    }
    Ok(())
}

fn configure_input_type(
    transform: &IMFTransform,
    config: &EncoderConfig,
    input_subtype: &windows::core::GUID,
) -> Result<(), VideoError> {
    unsafe {
        let input_type = MFCreateMediaType()
            .map_err(|err| VideoError::EncoderInit(format!("MFCreateMediaType failed: {err}")))?;
        set_common_media_type_fields(&input_type, config.width, config.height, config.fps)?;
        input_type
            .SetGUID(&MF_MT_SUBTYPE, input_subtype)
            .map_err(|err| VideoError::EncoderInit(format!("Set input subtype failed: {err}")))?;
        transform
            .SetInputType(INPUT_STREAM_ID, Some(&input_type), 0)
            .map_err(|err| VideoError::EncoderInit(format!("SetInputType failed: {err}")))?;
    }
    Ok(())
}

/// How the MFT is fed pixel data for a given encoder instance. Chosen ONCE at
/// construction and never switched at runtime (spec §0 "one deterministic route
/// per capability, chosen at construction").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MfInputMode {
    /// System-memory input: the caller hands I420 bytes to [`VideoEncoder::encode`],
    /// converted to NV12 through the reused scratch when the MFT wants NV12.
    /// This is the deterministic construction-time floor — used when no D3D11
    /// device was supplied, the MFT is not D3D11-aware, or it rejected an
    /// ARGB32 D3D surface input type. Loudly logged when it is a *fallback*.
    CpuSystemMemory,
    /// GPU texture input: the MFT is bound to the capture device through an
    /// `IMFDXGIDeviceManager` and accepts `MFVideoFormat_ARGB32` (BGRA) D3D11
    /// surfaces, so the RGB→NV12 color convert happens on the GPU inside the
    /// MFT. Frames arrive as `ID3D11Texture2D` via [`MfVideoEncoder::encode_texture`].
    GpuTextureArgb32,
}

/// Configure the input media type for GPU texture input (ARGB32 / BGRA). Unlike
/// [`configure_input_type`], the subtype is the packed 32-bit RGB the WGC
/// texture carries; the MFT does the color convert to its internal NV12 on the
/// GPU. The BT.709 matrix / nominal-range tags set by
/// [`set_common_media_type_fields`] describe the *output* YUV the MFT produces
/// (contract C1); on the RGB input type they are inert best-effort hints.
fn configure_input_type_texture(
    transform: &IMFTransform,
    config: &EncoderConfig,
) -> Result<(), VideoError> {
    unsafe {
        let input_type = MFCreateMediaType()
            .map_err(|err| VideoError::EncoderInit(format!("MFCreateMediaType failed: {err}")))?;
        set_common_media_type_fields(&input_type, config.width, config.height, config.fps)?;
        input_type
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_ARGB32)
            .map_err(|err| {
                VideoError::EncoderInit(format!("Set ARGB32 input subtype failed: {err}"))
            })?;
        transform
            .SetInputType(INPUT_STREAM_ID, Some(&input_type), 0)
            .map_err(|err| {
                VideoError::EncoderInit(format!("SetInputType(ARGB32) failed: {err}"))
            })?;
    }
    Ok(())
}

/// Report whether the MFT advertises D3D11 awareness (`MF_SA_D3D11_AWARE`).
/// Only such MFTs may be handed a DXGI device manager and D3D surface samples.
fn transform_is_d3d11_aware(transform: &IMFTransform) -> bool {
    unsafe {
        transform
            .GetAttributes()
            .ok()
            .and_then(|attrs| attrs.GetUINT32(&MF_SA_D3D11_AWARE).ok())
            .map(|v| v != 0)
            .unwrap_or(false)
    }
}

/// Build an `IMFDXGIDeviceManager` around the capture device and enable D3D11
/// multithread protection on that device.
///
/// LIFETIME / THREADING (spec §7, W4): the returned manager holds a COM ref on
/// `device`; the same device is used by the capture thread (to copy WGC pool
/// frames into encoder-fed textures) and by the MFT's own worker threads. The
/// D3D11 immediate context is not thread-safe, so multithread protection is
/// mandatory — without it the two producers race the context. We enable it here
/// rather than assume the capture side did.
fn create_dxgi_device_manager(
    device: &ID3D11Device,
) -> Result<(IMFDXGIDeviceManager, u32), VideoError> {
    unsafe {
        if let Ok(multithread) = device.cast::<ID3D11Multithread>() {
            // Returns the previous protection state; we only care that it is on.
            // windows-rs 0.61 takes a plain `bool` here, not a `BOOL`.
            let _ = multithread.SetMultithreadProtected(true);
        } else {
            return Err(VideoError::EncoderInit(
                "capture ID3D11Device does not expose ID3D11Multithread; refusing to share it \
                 with an MFT without multithread protection"
                    .into(),
            ));
        }

        let mut token = 0u32;
        let mut manager: Option<IMFDXGIDeviceManager> = None;
        MFCreateDXGIDeviceManager(&mut token, &mut manager).map_err(|err| {
            VideoError::EncoderInit(format!("MFCreateDXGIDeviceManager failed: {err}"))
        })?;
        let manager = manager.ok_or_else(|| {
            VideoError::EncoderInit("MFCreateDXGIDeviceManager returned a null manager".into())
        })?;
        manager.ResetDevice(device, token).map_err(|err| {
            VideoError::EncoderInit(format!("IMFDXGIDeviceManager::ResetDevice failed: {err}"))
        })?;
        Ok((manager, token))
    }
}

fn configure_output_type(
    transform: &IMFTransform,
    config: &EncoderConfig,
    codec_kind: MfCodecKind,
    output_subtype: &windows::core::GUID,
) -> Result<(), VideoError> {
    unsafe {
        let output_type = MFCreateMediaType()
            .map_err(|err| VideoError::EncoderInit(format!("MFCreateMediaType failed: {err}")))?;
        set_common_media_type_fields(&output_type, config.width, config.height, config.fps)?;
        output_type
            .SetGUID(&MF_MT_SUBTYPE, output_subtype)
            .map_err(|err| VideoError::EncoderInit(format!("Set output subtype failed: {err}")))?;
        output_type
            .SetUINT32(&MF_MT_AVG_BITRATE, config.bitrate_kbps.saturating_mul(1000))
            .map_err(|err| VideoError::EncoderInit(format!("Set avg bitrate failed: {err}")))?;
        output_type
            .SetUINT32(
                &MF_MT_MPEG2_PROFILE,
                match codec_kind {
                    MfCodecKind::H264 => eAVEncH264VProfile_High.0 as u32,
                    MfCodecKind::Av1 => eAVEncAV1VProfile_Main_420_8.0 as u32,
                },
            )
            .map_err(|err| {
                VideoError::EncoderInit(format!("Set {} profile failed: {err}", codec_kind.label()))
            })?;
        transform
            .SetOutputType(OUTPUT_STREAM_ID, Some(&output_type), 0)
            .map_err(|err| VideoError::EncoderInit(format!("SetOutputType failed: {err}")))?;
    }
    Ok(())
}

fn tune_transform(transform: &IMFTransform, config: &EncoderConfig, codec_kind: MfCodecKind) {
    unsafe {
        if let Ok(attributes) = transform.GetAttributes() {
            let _ = attributes.GetUINT32(&MF_TRANSFORM_ASYNC);
            let _ = attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
            let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);
        }

        if let Ok(codec_api) = transform.cast::<ICodecAPI>() {
            let _ = set_codec_api_bool(&codec_api, &CODECAPI_AVLowLatencyMode, true);
            let _ = set_codec_api_bool(&codec_api, &CODECAPI_AVEncCommonRealTime, true);
            // Peak-constrained VBR with a 1.5× ceiling lets the rate controller
            // spend on complex frames while capping bursts (K3), replacing the
            // implicit CBR the mean-bitrate-only config produced.
            let mean_bps = config.bitrate_kbps.saturating_mul(1000);
            let _ = set_codec_api_u32(
                &codec_api,
                &CODECAPI_AVEncCommonRateControlMode,
                eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32,
            );
            let _ = set_codec_api_u32(&codec_api, &CODECAPI_AVEncCommonMeanBitRate, mean_bps);
            let _ = set_codec_api_u32(
                &codec_api,
                &CODECAPI_AVEncCommonMaxBitRate,
                mean_bps.saturating_mul(3) / 2,
            );
            // Bias toward quality (0=speed, 100=quality); 70 keeps latency sane.
            let _ = set_codec_api_u32(&codec_api, &CODECAPI_AVEncCommonQualityVsSpeed, 70);
            let _ = set_codec_api_u32(
                &codec_api,
                &CODECAPI_AVEncMPVGOPSize,
                config.keyframe_interval.max(1),
            );
            if codec_kind == MfCodecKind::H264 {
                let _ = set_codec_api_u32(&codec_api, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
            }
        }
    };
}

fn variant_from_u32(value: u32) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_UI4,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { ulVal: value },
            }),
        },
    }
}

fn variant_from_bool(value: bool) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_BOOL,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 {
                    boolVal: value.into(),
                },
            }),
        },
    }
}

fn set_codec_api_u32(
    codec_api: &ICodecAPI,
    property: &windows::core::GUID,
    value: u32,
) -> windows::core::Result<()> {
    unsafe {
        codec_api.IsSupported(property)?;
        let variant = variant_from_u32(value);
        codec_api.SetValue(property, &variant)
    }
}

fn set_codec_api_bool(
    codec_api: &ICodecAPI,
    property: &windows::core::GUID,
    value: bool,
) -> windows::core::Result<()> {
    unsafe {
        codec_api.IsSupported(property)?;
        let variant = variant_from_bool(value);
        codec_api.SetValue(property, &variant)
    }
}

/// Convert planar I420 to interleaved NV12 into a reused output buffer. Single
/// pass; `out.clear()` retains the allocation so steady-state encoding does not
/// allocate per frame (K7).
fn i420_to_nv12_into(data: &[u8], width: u32, height: u32, out: &mut Vec<u8>) {
    let y_size = (width * height) as usize;
    let uv_plane_size = ((width / 2) * (height / 2)) as usize;
    let u_plane = &data[y_size..y_size + uv_plane_size];
    let v_plane = &data[y_size + uv_plane_size..y_size + 2 * uv_plane_size];

    out.clear();
    out.reserve(y_size + uv_plane_size * 2);
    out.extend_from_slice(&data[..y_size]);
    for (u, v) in u_plane.iter().zip(v_plane.iter()) {
        out.push(*u);
        out.push(*v);
    }
}

fn initialize_transform(
    transform: &IMFTransform,
    config: &EncoderConfig,
    codec_kind: MfCodecKind,
    selection: EncoderTypeSelection,
) -> Result<(), VideoError> {
    configure_output_type(transform, config, codec_kind, &selection.output_subtype)?;
    configure_input_type(transform, config, &selection.input_subtype)?;
    tune_transform(transform, config, codec_kind);
    unsafe {
        let _ = transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
        let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
    }
    Ok(())
}

fn initialize_encoder_transform(
    codec_kind: MfCodecKind,
    config: &EncoderConfig,
) -> Result<(IMFTransform, EncoderTypeSelection), VideoError> {
    let mut errors = Vec::new();
    let input_subtypes = [MFVideoFormat_NV12, MFVideoFormat_I420];
    for input_subtype in input_subtypes {
        for output_subtype in codec_kind.output_candidates() {
            let selection = EncoderTypeSelection {
                input_subtype,
                output_subtype: *output_subtype,
                hardware: true,
            };
            if let Some(transform) =
                enumerate_hardware_encoder(selection.input_subtype, selection.output_subtype)?
            {
                match initialize_transform(&transform, config, codec_kind, selection) {
                    Ok(()) => {
                        tracing::info!(
                            codec = codec_kind.label(),
                            hardware = selection.hardware,
                            input_subtype = ?selection.input_subtype,
                            output_subtype = ?selection.output_subtype,
                            "initialized Windows Media Foundation encoder backend"
                        );
                        return Ok((transform, selection));
                    }
                    Err(err) => {
                        errors.push(format!(
                            "hardware {:?}->{:?} rejected: {err}",
                            selection.input_subtype, selection.output_subtype
                        ));
                        tracing::warn!(
                            codec = codec_kind.label(),
                            hardware = selection.hardware,
                            input_subtype = ?selection.input_subtype,
                            output_subtype = ?selection.output_subtype,
                            error = %err,
                            "Windows Media Foundation hardware encoder candidate rejected during initialization"
                        );
                    }
                }
            }
        }
    }

    // No software MFT fallback: this engine is hardware-only. A GPU-less
    // Windows box must fail here so codec negotiation falls to the tuned libvpx
    // VP9 path instead of letting an untuned software H.264 MFT win (K8).

    Err(VideoError::CodecUnavailable(if errors.is_empty() {
        format!(
            "no usable Windows {} encoder configuration found",
            codec_kind.label()
        )
    } else {
        format!(
            "no usable Windows {} encoder configuration found: {}",
            codec_kind.label(),
            errors.join(" | ")
        )
    }))
}

/// Attempt to initialize a D3D11 texture-input encoder transform (spec §7). On
/// success the returned transform is bound to `device` through the returned
/// device manager and accepts `MFVideoFormat_ARGB32` (BGRA) D3D11 surfaces, so
/// the RGB→NV12 color convert runs on the GPU inside the MFT.
///
/// Returns `Ok(None)` when no D3D11-aware MFT accepts ARGB32 input — the caller
/// then falls to the CPU NV12 floor, loudly. `Err` is reserved for hard COM
/// failures (device-manager creation).
///
/// COMPILE-UNVERIFIED (Windows-only). Reviewed against windows-rs 0.61.
fn initialize_texture_encoder_transform(
    codec_kind: MfCodecKind,
    config: &EncoderConfig,
    device: &ID3D11Device,
) -> Result<
    Option<(
        IMFTransform,
        EncoderTypeSelection,
        IMFDXGIDeviceManager,
        u32,
    )>,
    VideoError,
> {
    for output_subtype in codec_kind.output_candidates() {
        // Hardware encoders register NV12 system-memory input; enumerate by that
        // to find the device, then attach the DXGI manager and override the
        // input type to ARGB32 D3D surfaces below.
        let Some(transform) = enumerate_hardware_encoder(MFVideoFormat_NV12, *output_subtype)?
        else {
            continue;
        };
        if !transform_is_d3d11_aware(&transform) {
            tracing::warn!(
                codec = codec_kind.label(),
                output_subtype = ?output_subtype,
                "Windows MFT is not MF_SA_D3D11_AWARE; cannot accept GPU texture input"
            );
            continue;
        }

        let (manager, token) = create_dxgi_device_manager(device)?;

        unsafe {
            // Async hardware MFTs must be unlocked before use (mirrors the CPU
            // path's tune step, done here up front so SET_D3D_MANAGER lands on an
            // unlocked transform).
            if let Ok(attributes) = transform.GetAttributes() {
                let _ = attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
            }
            // Attach the shared device BEFORE media types so the MFT allocates
            // its internal surfaces on the capture device.
            if let Err(err) =
                transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
            {
                tracing::warn!(
                    codec = codec_kind.label(),
                    error = %err,
                    "MFT_MESSAGE_SET_D3D_MANAGER rejected; MFT will not take GPU input"
                );
                continue;
            }
        }

        if let Err(err) = configure_output_type(&transform, config, codec_kind, output_subtype) {
            tracing::warn!(codec = codec_kind.label(), error = %err, "GPU-input MFT rejected output type");
            continue;
        }
        if let Err(err) = configure_input_type_texture(&transform, config) {
            // D3D11-aware but will not take ARGB32 directly (it wants NV12
            // surfaces). A GPU NV12 convert would need a separate video-processor
            // MFT, which is out of scope; fall to the CPU NV12 floor rather than
            // silently degrade the route.
            tracing::warn!(
                codec = codec_kind.label(),
                error = %err,
                "D3D11-aware MFT rejected ARGB32 input; GPU color-convert path unavailable"
            );
            continue;
        }

        let selection = EncoderTypeSelection {
            input_subtype: MFVideoFormat_ARGB32,
            output_subtype: *output_subtype,
            hardware: true,
        };
        tune_transform(&transform, config, codec_kind);
        unsafe {
            let _ = transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
            let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        }
        tracing::info!(
            codec = codec_kind.label(),
            output_subtype = ?output_subtype,
            "initialized Windows MFT with GPU D3D11 ARGB32 texture input (zero-copy WGC→MFT)"
        );
        return Ok(Some((transform, selection, manager, token)));
    }
    Ok(None)
}

/// Wrap an `ID3D11Texture2D` (subresource 0) as an `IMFMediaBuffer` for MFT
/// input. The buffer holds a COM ref on the texture, so the texture stays alive
/// for as long as the sample does even if the caller drops its handle.
fn dxgi_surface_buffer_from_texture(
    texture: &ID3D11Texture2D,
) -> Result<IMFMediaBuffer, VideoError> {
    unsafe {
        // `false` = top-down (the DOM/BGRA convention WGC delivers), matching the
        // way the CPU path treats the packed buffer. windows-rs 0.61 takes a
        // plain `bool` for `fBottomUpWhenLinear`, not a `BOOL`.
        let buffer =
            MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false).map_err(|err| {
                VideoError::EncodeFailed(format!("MFCreateDXGISurfaceBuffer failed: {err}"))
            })?;
        // DXGI surface buffers report a zero current length until told otherwise;
        // some MFTs validate it. Set it from the 2D buffer's contiguous length.
        if let Ok(buf2d) = buffer.cast::<IMF2DBuffer>() {
            if let Ok(len) = buf2d.GetContiguousLength() {
                let _ = buffer.SetCurrentLength(len);
            }
        }
        Ok(buffer)
    }
}

/// Create the reusable input sample backed by one memory buffer sized to the
/// frame. Created once per encoder and refilled each frame by
/// [`refill_input_sample`] (K7).
fn create_reusable_input_sample(capacity: usize) -> Result<IMFSample, VideoError> {
    unsafe {
        let sample = MFCreateSample()
            .map_err(|err| VideoError::EncodeFailed(format!("MFCreateSample failed: {err}")))?;
        let buffer = MFCreateMemoryBuffer(
            u32::try_from(capacity)
                .map_err(|_| VideoError::EncodeFailed("input frame too large".into()))?,
        )
        .map_err(|err| VideoError::EncodeFailed(format!("MFCreateMemoryBuffer failed: {err}")))?;
        sample
            .AddBuffer(&buffer)
            .map_err(|err| VideoError::EncodeFailed(format!("AddBuffer failed: {err}")))?;
        Ok(sample)
    }
}

/// Refill the reused input sample's buffer with a new frame and stamp its
/// timestamp/duration. The synchronous drive loop drains the MFT fully each
/// call, so the buffer is free to be rewritten on the next frame.
fn refill_input_sample(
    sample: &IMFSample,
    data: &[u8],
    pts_hns: i64,
    duration_hns: i64,
) -> Result<(), VideoError> {
    unsafe {
        let buffer = sample
            .GetBufferByIndex(0)
            .map_err(|err| VideoError::EncodeFailed(format!("GetBufferByIndex failed: {err}")))?;
        copy_into_buffer(&buffer, data)?;
        sample
            .SetSampleTime(pts_hns)
            .map_err(|err| VideoError::EncodeFailed(format!("SetSampleTime failed: {err}")))?;
        sample
            .SetSampleDuration(duration_hns)
            .map_err(|err| VideoError::EncodeFailed(format!("SetSampleDuration failed: {err}")))?;
    }
    Ok(())
}

fn copy_into_buffer(buffer: &IMFMediaBuffer, data: &[u8]) -> Result<(), VideoError> {
    unsafe {
        let mut ptr = null_mut();
        buffer
            .Lock(&mut ptr, None, None)
            .map_err(|err| VideoError::EncodeFailed(format!("buffer lock failed: {err}")))?;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        let set_length = buffer.SetCurrentLength(
            u32::try_from(data.len())
                .map_err(|_| VideoError::EncodeFailed("buffer length overflow".into()))?,
        );
        let unlock = buffer.Unlock();
        set_length
            .map_err(|err| VideoError::EncodeFailed(format!("SetCurrentLength failed: {err}")))?;
        unlock.map_err(|err| VideoError::EncodeFailed(format!("buffer unlock failed: {err}")))?;
    }
    Ok(())
}

fn extract_sample_bytes(sample: &IMFSample) -> Result<Vec<u8>, VideoError> {
    unsafe {
        let buffer = sample.ConvertToContiguousBuffer().map_err(|err| {
            VideoError::EncodeFailed(format!("ConvertToContiguousBuffer failed: {err}"))
        })?;
        let length = buffer
            .GetCurrentLength()
            .map_err(|err| VideoError::EncodeFailed(format!("GetCurrentLength failed: {err}")))?
            as usize;
        let mut ptr = null_mut();
        buffer
            .Lock(&mut ptr, None, None)
            .map_err(|err| VideoError::EncodeFailed(format!("output buffer lock failed: {err}")))?;
        let bytes = std::slice::from_raw_parts(ptr, length).to_vec();
        buffer.Unlock().map_err(|err| {
            VideoError::EncodeFailed(format!("output buffer unlock failed: {err}"))
        })?;
        Ok(bytes)
    }
}

fn sample_is_keyframe(sample: &IMFSample) -> bool {
    unsafe {
        sample
            .GetUINT32(&MFSampleExtension_CleanPoint)
            .map(|value| value != 0)
            .unwrap_or(false)
    }
}

fn create_output_buffer_sample(transform: &IMFTransform) -> Result<Option<IMFSample>, VideoError> {
    unsafe {
        let stream_info = transform
            .GetOutputStreamInfo(OUTPUT_STREAM_ID)
            .map_err(|err| {
                VideoError::EncodeFailed(format!("GetOutputStreamInfo failed: {err}"))
            })?;

        if (stream_info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32) != 0
            || (stream_info.dwFlags & MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0
        {
            return Ok(None);
        }

        let capacity = stream_info.cbSize.max(256 * 1024);
        let sample = MFCreateSample()
            .map_err(|err| VideoError::EncodeFailed(format!("MFCreateSample failed: {err}")))?;
        let buffer = MFCreateMemoryBuffer(capacity).map_err(|err| {
            VideoError::EncodeFailed(format!("MFCreateMemoryBuffer failed: {err}"))
        })?;
        sample
            .AddBuffer(&buffer)
            .map_err(|err| VideoError::EncodeFailed(format!("AddBuffer failed: {err}")))?;
        Ok(Some(sample))
    }
}

fn collect_output(
    transform: &IMFTransform,
    config: &EncoderConfig,
    codec: VideoCodec,
) -> Result<Vec<EncodedFrame>, VideoError> {
    let mut encoded = Vec::new();
    unsafe {
        loop {
            let sample = create_output_buffer_sample(transform)?;
            let mut output = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: OUTPUT_STREAM_ID,
                pSample: ManuallyDrop::new(sample),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            }];
            let mut status = 0u32;
            let result = transform.ProcessOutput(0, &mut output, &mut status);
            // Move the COM refs out of the `ManuallyDrop` output fields so they
            // are released on every path (Ok, need-more-input break, and error
            // return). The old `as_ref().cloned()` only bumped the sample's
            // refcount and dropped the clone, leaking the original ref the MFT (or
            // our pre-allocated buffer) left in `pSample`; `pEvents` was never
            // released at all. `ManuallyDrop::take` hands over ownership so both
            // drop normally.
            let sample_ref = ManuallyDrop::take(&mut output[0].pSample);
            let _events = ManuallyDrop::take(&mut output[0].pEvents);
            match result {
                Ok(()) => {
                    if let Some(sample) = sample_ref {
                        let data = extract_sample_bytes(&sample)?;
                        if !data.is_empty() {
                            // Trusting MFSampleExtension_CleanPoint alone is
                            // unsafe: a hardware MFT that mislabels keyframes
                            // leaves viewers unable to prime (permanent blank
                            // stream). For AV1, OR in a real OBU temporal-unit
                            // parse so a lying CleanPoint cannot hide a keyframe
                            // (K6).
                            let is_keyframe = sample_is_keyframe(&sample)
                                || (codec == VideoCodec::Av1
                                    && crate::video::av1_temporal_unit_is_keyframe(&data));
                            encoded.push(EncodedFrame {
                                data,
                                codec,
                                pts: sample.GetSampleTime().unwrap_or_default()
                                    / (HNS_PER_SECOND / config.fps.max(1) as i64),
                                is_keyframe,
                                layer: None,
                                width: config.width,
                                height: config.height,
                                // The MFT is configured for BT.709 limited range
                                // (MF_MT_YUV_MATRIX / nominal range), contract C1.
                                colorspace: ColorSpace::Bt709,
                            });
                        }
                    }
                }
                Err(err) if err.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                Err(err) => {
                    return Err(VideoError::EncodeFailed(format!(
                        "ProcessOutput failed: {err}"
                    )))
                }
            }
        }
    }
    Ok(encoded)
}

pub struct MfH264Encoder {
    inner: MfVideoEncoder,
}

pub struct MfAv1Encoder {
    inner: MfVideoEncoder,
}

struct MfVideoEncoder {
    transform: IMFTransform,
    config: EncoderConfig,
    selection: EncoderTypeSelection,
    codec_kind: MfCodecKind,
    /// How this encoder is fed, chosen once at construction (spec §7). Governs
    /// which of [`encode`](VideoEncoder::encode) / [`encode_texture`] is valid.
    input_mode: MfInputMode,
    /// DXGI device manager kept alive for the encoder's lifetime in GPU mode.
    /// The MFT holds its own ref after `MFT_MESSAGE_SET_D3D_MANAGER`; we retain
    /// ours so the shared capture device cannot be released out from under the
    /// MFT. `None` in the CPU floor. Reset token retained beside it.
    _dxgi_manager: Option<IMFDXGIDeviceManager>,
    _d3d_reset_token: u32,
    /// Reused NV12 conversion scratch (only when the MFT wants NV12 input),
    /// sized once so the per-frame conversion no longer allocates.
    nv12_scratch: Vec<u8>,
    /// Reused input sample + memory buffer fed to `ProcessInput` each frame,
    /// avoiding a per-frame `MFCreateSample`/`MFCreateMemoryBuffer`.
    input_sample: Option<IMFSample>,
    /// Count of input frames the MFT could not accept and were dropped.
    dropped_frames: u64,
}

unsafe impl Send for MfH264Encoder {}
unsafe impl Send for MfAv1Encoder {}
unsafe impl Send for MfVideoEncoder {}

impl MfVideoEncoder {
    fn new(codec_kind: MfCodecKind, config: EncoderConfig) -> Result<Self, VideoError> {
        config.validate()?;
        if config.pixel_format != PixelFormat::I420 {
            return Err(VideoError::UnsupportedPixelFormat(config.pixel_format));
        }

        ensure_com_multithreaded()?;
        ensure_media_foundation()?;

        let (transform, selection) = initialize_encoder_transform(codec_kind, &config)?;

        Ok(Self {
            transform,
            config,
            selection,
            codec_kind,
            input_mode: MfInputMode::CpuSystemMemory,
            _dxgi_manager: None,
            _d3d_reset_token: 0,
            nv12_scratch: Vec::new(),
            input_sample: None,
            dropped_frames: 0,
        })
    }

    /// Construct an encoder that takes zero-copy D3D11 texture input (spec §7),
    /// with the CPU NV12 pass as the construction-time floor.
    ///
    /// The route is decided ONCE here: if a D3D11-aware hardware MFT for this
    /// codec accepts `MFVideoFormat_ARGB32` surfaces on the shared `device`, the
    /// encoder runs in [`MfInputMode::GpuTextureArgb32`] and expects frames via
    /// [`encode_texture`]. Otherwise it loudly logs the reason and falls back to
    /// the existing CPU system-memory pipeline (identical to [`new`]), which
    /// expects I420 via [`VideoEncoder::encode`]. There is no runtime switching.
    ///
    /// `device` must be the same `ID3D11Device` that produced the input
    /// textures (the capture/WGC device), so the MFT and the texture allocations
    /// live on one device and no cross-device shared handle is required
    /// (spec §7 "shared device").
    fn new_with_d3d_device(
        codec_kind: MfCodecKind,
        config: EncoderConfig,
        device: &ID3D11Device,
    ) -> Result<Self, VideoError> {
        config.validate()?;
        if config.pixel_format != PixelFormat::I420 {
            // The output/scratch geometry is still described in I420 terms; the
            // GPU input is ARGB32 regardless. Reject anything else so the CPU
            // floor's assumptions hold.
            return Err(VideoError::UnsupportedPixelFormat(config.pixel_format));
        }

        ensure_com_multithreaded()?;
        ensure_media_foundation()?;

        match initialize_texture_encoder_transform(codec_kind, &config, device) {
            Ok(Some((transform, selection, manager, token))) => Ok(Self {
                transform,
                config,
                selection,
                codec_kind,
                input_mode: MfInputMode::GpuTextureArgb32,
                _dxgi_manager: Some(manager),
                _d3d_reset_token: token,
                nv12_scratch: Vec::new(),
                input_sample: None,
                dropped_frames: 0,
            }),
            Ok(None) => {
                tracing::warn!(
                    codec = codec_kind.label(),
                    "no D3D11-aware MFT accepted ARGB32 texture input; using CPU NV12 pass \
                     (construction-time floor, spec §7)"
                );
                Self::new(codec_kind, config)
            }
            Err(err) => {
                tracing::warn!(
                    codec = codec_kind.label(),
                    error = %err,
                    "D3D11 texture encoder setup failed; using CPU NV12 pass \
                     (construction-time floor, spec §7)"
                );
                Self::new(codec_kind, config)
            }
        }
    }

    /// Encode one GPU texture (subresource 0 of `texture`, `MFVideoFormat_ARGB32`
    /// / BGRA on the shared device). Only valid in [`MfInputMode::GpuTextureArgb32`].
    ///
    /// Fails loudly if called on a CPU-mode encoder — a texture reaching a CPU
    /// encoder means the route was mis-negotiated, and silently converting it on
    /// the CPU would violate the "one deterministic route" law (spec §0).
    fn encode_texture(
        &mut self,
        pts: i64,
        texture: &ID3D11Texture2D,
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        if self.input_mode != MfInputMode::GpuTextureArgb32 {
            return Err(VideoError::EncodeFailed(
                "encode_texture called on a CPU-system-memory MF encoder (route mis-negotiated)"
                    .into(),
            ));
        }

        unsafe {
            if force_keyframe {
                if let Ok(codec_api) = self.transform.cast::<ICodecAPI>() {
                    let _ = set_codec_api_u32(&codec_api, &CODECAPI_AVEncVideoForceKeyFrame, 1);
                }
            }

            let input_status = self
                .transform
                .GetInputStatus(INPUT_STREAM_ID)
                .map_err(|err| VideoError::EncodeFailed(format!("GetInputStatus failed: {err}")))?;
            if (input_status & MFT_INPUT_STATUS_ACCEPT_DATA.0 as u32) == 0 {
                self.dropped_frames = self.dropped_frames.saturating_add(1);
                return collect_output(&self.transform, &self.config, self.codec());
            }

            let frame_duration = HNS_PER_SECOND / self.config.fps.max(1) as i64;
            // A DXGI surface buffer must reference the live texture, so — unlike
            // the CPU path — the sample is rebuilt each frame rather than reused.
            let buffer = dxgi_surface_buffer_from_texture(texture)?;
            let sample = MFCreateSample()
                .map_err(|err| VideoError::EncodeFailed(format!("MFCreateSample failed: {err}")))?;
            sample
                .AddBuffer(&buffer)
                .map_err(|err| VideoError::EncodeFailed(format!("AddBuffer failed: {err}")))?;
            sample
                .SetSampleTime(pts * frame_duration)
                .map_err(|err| VideoError::EncodeFailed(format!("SetSampleTime failed: {err}")))?;
            sample.SetSampleDuration(frame_duration).map_err(|err| {
                VideoError::EncodeFailed(format!("SetSampleDuration failed: {err}"))
            })?;
            self.transform
                .ProcessInput(INPUT_STREAM_ID, &sample, 0)
                .map_err(|err| VideoError::EncodeFailed(format!("ProcessInput failed: {err}")))?;
        }

        collect_output(&self.transform, &self.config, self.codec())
    }

    fn probe_backend(
        codec_kind: MfCodecKind,
        config: Option<EncoderConfig>,
    ) -> Result<WindowsMfBackendProbe, VideoError> {
        let config = config.unwrap_or(EncoderConfig {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 8_000,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 30,
            content_hint: super::super::VideoContentHint::Motion,
        });
        config.validate()?;
        if config.pixel_format != PixelFormat::I420 {
            return Err(VideoError::UnsupportedPixelFormat(config.pixel_format));
        }

        ensure_com_multithreaded()?;
        ensure_media_foundation()?;
        let (_transform, selection) = initialize_encoder_transform(codec_kind, &config)?;
        Ok(WindowsMfBackendProbe {
            hardware_accelerated: selection.hardware,
        })
    }
}

impl MfH264Encoder {
    pub fn new(config: EncoderConfig) -> Result<Self, VideoError> {
        Ok(Self {
            inner: MfVideoEncoder::new(MfCodecKind::H264, config)?,
        })
    }

    /// Construct with zero-copy D3D11 texture input on `device` (spec §7), CPU
    /// NV12 as the construction-time floor. See
    /// [`MfVideoEncoder::new_with_d3d_device`].
    pub fn new_with_d3d_device(
        config: EncoderConfig,
        device: &ID3D11Device,
    ) -> Result<Self, VideoError> {
        Ok(Self {
            inner: MfVideoEncoder::new_with_d3d_device(MfCodecKind::H264, config, device)?,
        })
    }

    /// Whether this encoder actually consumes GPU textures (vs the CPU floor).
    pub fn takes_texture_input(&self) -> bool {
        self.inner.input_mode == MfInputMode::GpuTextureArgb32
    }

    /// Encode one BGRA D3D11 texture. See [`MfVideoEncoder::encode_texture`].
    pub fn encode_texture(
        &mut self,
        pts: i64,
        texture: &ID3D11Texture2D,
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        self.inner.encode_texture(pts, texture, force_keyframe)
    }

    pub fn probe_backend(
        config: Option<EncoderConfig>,
    ) -> Result<WindowsH264BackendProbe, VideoError> {
        MfVideoEncoder::probe_backend(MfCodecKind::H264, config).map(|probe| {
            WindowsH264BackendProbe {
                hardware_accelerated: probe.hardware_accelerated,
            }
        })
    }
}

impl MfAv1Encoder {
    pub fn new(config: EncoderConfig) -> Result<Self, VideoError> {
        Ok(Self {
            inner: MfVideoEncoder::new(MfCodecKind::Av1, config)?,
        })
    }

    /// Construct with zero-copy D3D11 texture input on `device` (spec §7), CPU
    /// NV12 as the construction-time floor. See
    /// [`MfVideoEncoder::new_with_d3d_device`].
    pub fn new_with_d3d_device(
        config: EncoderConfig,
        device: &ID3D11Device,
    ) -> Result<Self, VideoError> {
        Ok(Self {
            inner: MfVideoEncoder::new_with_d3d_device(MfCodecKind::Av1, config, device)?,
        })
    }

    /// Whether this encoder actually consumes GPU textures (vs the CPU floor).
    pub fn takes_texture_input(&self) -> bool {
        self.inner.input_mode == MfInputMode::GpuTextureArgb32
    }

    /// Encode one BGRA D3D11 texture. See [`MfVideoEncoder::encode_texture`].
    pub fn encode_texture(
        &mut self,
        pts: i64,
        texture: &ID3D11Texture2D,
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        self.inner.encode_texture(pts, texture, force_keyframe)
    }

    pub fn probe_backend(
        config: Option<EncoderConfig>,
    ) -> Result<WindowsAv1BackendProbe, VideoError> {
        MfVideoEncoder::probe_backend(MfCodecKind::Av1, config).map(|probe| {
            WindowsAv1BackendProbe {
                hardware_accelerated: probe.hardware_accelerated,
            }
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsMfBackendProbe {
    pub hardware_accelerated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsH264BackendProbe {
    pub hardware_accelerated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsAv1BackendProbe {
    pub hardware_accelerated: bool,
}

impl VideoEncoder for MfVideoEncoder {
    fn encode(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        if self.input_mode == MfInputMode::GpuTextureArgb32 {
            // A GPU-input encoder must be driven with encode_texture; routing CPU
            // bytes here would silently establish a second path (spec §0).
            return Err(VideoError::EncodeFailed(
                "encode(&[u8]) called on a GPU-texture MF encoder; use encode_texture".into(),
            ));
        }
        let expected = packed_size(self.config.width, self.config.height) as usize;
        if data.len() != expected {
            return Err(VideoError::FrameSizeMismatch {
                expected,
                actual: data.len(),
            });
        }

        // Feed NV12 (the MFT-preferred input) via the reused scratch buffer, or
        // I420 directly when that is the negotiated input subtype.
        let input_data: &[u8] = if self.selection.input_subtype == MFVideoFormat_NV12 {
            i420_to_nv12_into(
                data,
                self.config.width,
                self.config.height,
                &mut self.nv12_scratch,
            );
            &self.nv12_scratch
        } else {
            data
        };

        unsafe {
            if force_keyframe {
                if let Ok(codec_api) = self.transform.cast::<ICodecAPI>() {
                    let _ = set_codec_api_u32(&codec_api, &CODECAPI_AVEncVideoForceKeyFrame, 1);
                }
            }

            let input_status = self
                .transform
                .GetInputStatus(INPUT_STREAM_ID)
                .map_err(|err| VideoError::EncodeFailed(format!("GetInputStatus failed: {err}")))?;
            if (input_status & MFT_INPUT_STATUS_ACCEPT_DATA.0 as u32) == 0 {
                // The MFT cannot accept this frame; it is dropped. Account it and
                // drain whatever output is already ready.
                self.dropped_frames = self.dropped_frames.saturating_add(1);
                return collect_output(&self.transform, &self.config, self.codec());
            }

            let frame_duration = HNS_PER_SECOND / self.config.fps.max(1) as i64;
            if self.input_sample.is_none() {
                self.input_sample = Some(create_reusable_input_sample(expected)?);
            }
            let sample = self
                .input_sample
                .as_ref()
                .expect("input sample was just created");
            refill_input_sample(sample, input_data, pts * frame_duration, frame_duration)?;
            self.transform
                .ProcessInput(INPUT_STREAM_ID, sample, 0)
                .map_err(|err| VideoError::EncodeFailed(format!("ProcessInput failed: {err}")))?;
        }

        collect_output(&self.transform, &self.config, self.codec())
    }

    fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)
                .map_err(|err| {
                    VideoError::EncodeFailed(format!("ProcessMessage(DRAIN) failed: {err}"))
                })?;
        }
        collect_output(&self.transform, &self.config, self.codec())
    }

    fn config(&self) -> &EncoderConfig {
        &self.config
    }

    fn codec(&self) -> VideoCodec {
        self.codec_kind.codec()
    }

    fn backend_name(&self) -> &'static str {
        "media-foundation"
    }

    fn is_hardware_accelerated(&self) -> bool {
        self.selection.hardware
    }

    fn dropped_frames(&self) -> u64 {
        self.dropped_frames
    }

    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<bool, VideoError> {
        // Media Foundation encoders accept a live mean-bitrate change through
        // ICodecAPI without reinitializing (K1). Attempt it; on S_OK the new
        // rate is live and we report success, otherwise the caller keeps the
        // current rate.
        let bitrate_kbps = bitrate_kbps.max(1);
        unsafe {
            if let Ok(codec_api) = self.transform.cast::<ICodecAPI>() {
                if set_codec_api_u32(
                    &codec_api,
                    &CODECAPI_AVEncCommonMeanBitRate,
                    bitrate_kbps.saturating_mul(1000),
                )
                .is_ok()
                {
                    self.config.bitrate_kbps = bitrate_kbps;
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

impl VideoEncoder for MfH264Encoder {
    fn encode(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        self.inner.encode(pts, data, force_keyframe)
    }

    fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        self.inner.flush()
    }

    fn config(&self) -> &EncoderConfig {
        self.inner.config()
    }

    fn codec(&self) -> VideoCodec {
        self.inner.codec()
    }

    fn backend_name(&self) -> &'static str {
        self.inner.backend_name()
    }

    fn is_hardware_accelerated(&self) -> bool {
        self.inner.is_hardware_accelerated()
    }

    fn dropped_frames(&self) -> u64 {
        self.inner.dropped_frames()
    }

    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<bool, VideoError> {
        self.inner.set_bitrate(bitrate_kbps)
    }
}

impl VideoEncoder for MfAv1Encoder {
    fn encode(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        self.inner.encode(pts, data, force_keyframe)
    }

    fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        self.inner.flush()
    }

    fn config(&self) -> &EncoderConfig {
        self.inner.config()
    }

    fn codec(&self) -> VideoCodec {
        self.inner.codec()
    }

    fn backend_name(&self) -> &'static str {
        self.inner.backend_name()
    }

    fn is_hardware_accelerated(&self) -> bool {
        self.inner.is_hardware_accelerated()
    }

    fn dropped_frames(&self) -> u64 {
        self.inner.dropped_frames()
    }

    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<bool, VideoError> {
        self.inner.set_bitrate(bitrate_kbps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::VideoContentHint;

    #[test]
    fn windows_h264_encoder_initializes() {
        let config = EncoderConfig {
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_kbps: 25_000,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 60,
            content_hint: VideoContentHint::Motion,
        };

        let result = MfH264Encoder::new(config);
        if let Err(err) = &result {
            println!("windows_h264_encoder_initializes error: {err}");
        }
        assert!(result.is_ok(), "{}", result.err().unwrap());
    }

    #[test]
    fn windows_h264_encoder_emits_reasonably_sized_access_unit() {
        let config = EncoderConfig {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 8_000,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 30,
            content_hint: VideoContentHint::Motion,
        };

        let mut encoder = MfH264Encoder::new(config.clone()).expect("encoder init");
        let frame = vec![0x10u8; PixelFormat::I420.frame_size(config.width, config.height)];

        let mut encoded = Vec::new();
        for pts in 0..120 {
            let packets = encoder
                .encode(pts, &frame, pts == 0)
                .expect("encode succeeds");
            if !packets.is_empty() {
                println!(
                    "first_h264_output_pts={} packet_info={:?}",
                    pts,
                    packets
                        .iter()
                        .map(|packet| (packet.data.len(), packet.is_keyframe))
                        .collect::<Vec<_>>()
                );
                encoded = packets;
                break;
            }
        }

        assert!(
            !encoded.is_empty(),
            "expected the H264 encoder to emit at least one access unit after warmup"
        );
        let raw_i420_size = PixelFormat::I420.frame_size(config.width, config.height);
        let largest = encoded
            .iter()
            .map(|packet| packet.data.len())
            .max()
            .unwrap_or(0);
        println!(
            "largest_h264_access_unit={} raw_i420_size={}",
            largest, raw_i420_size
        );
        assert!(
            largest < raw_i420_size / 2,
            "H264 access unit is implausibly large for compressed output: largest={largest} raw_i420_size={raw_i420_size}"
        );
    }

    #[test]
    fn windows_h264_encoder_initializes_near_fullhd_window_size() {
        let config = EncoderConfig {
            width: 1918,
            height: 1078,
            fps: 60,
            bitrate_kbps: 25_000,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 60,
            content_hint: VideoContentHint::Motion,
        };

        let result = MfH264Encoder::new(config);
        if let Err(err) = &result {
            println!("windows_h264_encoder_initializes_near_fullhd_window_size error: {err}");
        }
        assert!(result.is_ok(), "{}", result.err().unwrap());
    }

    #[test]
    fn windows_h264_encoder_emits_output_for_near_fullhd_window_size() {
        let config = EncoderConfig {
            width: 1918,
            height: 1078,
            fps: 60,
            bitrate_kbps: 25_000,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 60,
            content_hint: VideoContentHint::Motion,
        };

        let mut encoder = MfH264Encoder::new(config.clone()).expect("encoder init");
        let frame = vec![0x10u8; PixelFormat::I420.frame_size(config.width, config.height)];

        let mut first_output_pts = None;
        for pts in 0..120 {
            let packets = encoder
                .encode(pts, &frame, pts == 0)
                .expect("encode succeeds");
            if !packets.is_empty() {
                first_output_pts = Some(pts);
                println!(
                    "near_fullhd_first_h264_output_pts={} packet_info={:?}",
                    pts,
                    packets
                        .iter()
                        .map(|packet| (packet.data.len(), packet.is_keyframe))
                        .collect::<Vec<_>>()
                );
                break;
            }
        }

        assert!(
            first_output_pts.is_some(),
            "expected H264 output for a near-fullhd window-sized stream"
        );
    }
}
