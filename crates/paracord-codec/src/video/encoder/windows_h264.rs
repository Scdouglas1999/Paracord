use super::{EncodedFrame, EncoderConfig, PixelFormat, VideoCodec, VideoEncoder, VideoError};
use std::mem::ManuallyDrop;
use std::ptr::null_mut;
use std::sync::OnceLock;
use windows::core::Interface;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::Media::MediaFoundation::{
    eAVEncAV1VProfile_Main_420_8, eAVEncH264VProfile_High, CLSID_MSH264EncoderMFT,
    CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonRealTime,
    CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize,
    CODECAPI_AVEncVideoForceKeyFrame, CODECAPI_AVLowLatencyMode, ICodecAPI, IMFActivate,
    IMFMediaBuffer, IMFMediaType, IMFSample, IMFTransform, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFMediaType_Video, MFSampleExtension_CleanPoint, MFStartup, MFTEnumEx,
    MFVideoFormat_AV1, MFVideoFormat_H264, MFVideoFormat_H264_ES, MFVideoFormat_I420,
    MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFSTARTUP_FULL, MFT_CATEGORY_VIDEO_ENCODER,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_INPUT_STATUS_ACCEPT_DATA,
    MFT_MESSAGE_COMMAND_DRAIN, MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES,
    MFT_REGISTER_TYPE_INFO, MF_E_TRANSFORM_NEED_MORE_INPUT, MF_LOW_LATENCY, MF_MT_AVG_BITRATE,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
    MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_TRANSFORM_ASYNC,
    MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Variant::{
    VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_UI4,
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

fn create_fallback_encoder() -> Result<IMFTransform, VideoError> {
    unsafe {
        CoCreateInstance::<_, IMFTransform>(&CLSID_MSH264EncoderMFT, None, CLSCTX_INPROC_SERVER)
            .map_err(|err| {
                VideoError::EncoderInit(format!("software H264 encoder init failed: {err}"))
            })
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
            let _ = set_codec_api_u32(
                &codec_api,
                &CODECAPI_AVEncCommonMeanBitRate,
                config.bitrate_kbps.saturating_mul(1000),
            );
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

fn i420_to_nv12(data: &[u8], width: u32, height: u32) -> Vec<u8> {
    let y_size = (width * height) as usize;
    let uv_plane_size = ((width / 2) * (height / 2)) as usize;
    let u_plane = &data[y_size..y_size + uv_plane_size];
    let v_plane = &data[y_size + uv_plane_size..y_size + 2 * uv_plane_size];

    let mut nv12 = Vec::with_capacity(y_size + (uv_plane_size * 2));
    nv12.extend_from_slice(&data[..y_size]);
    for (u, v) in u_plane.iter().zip(v_plane.iter()) {
        nv12.push(*u);
        nv12.push(*v);
    }
    nv12
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

    if codec_kind == MfCodecKind::H264 {
        for input_subtype in input_subtypes {
            for output_subtype in codec_kind.output_candidates() {
                let selection = EncoderTypeSelection {
                    input_subtype,
                    output_subtype: *output_subtype,
                    hardware: false,
                };
                let transform = create_fallback_encoder()?;
                match initialize_transform(&transform, config, codec_kind, selection) {
                    Ok(()) => {
                        tracing::warn!(
                            codec = codec_kind.label(),
                            hardware = selection.hardware,
                            input_subtype = ?selection.input_subtype,
                            output_subtype = ?selection.output_subtype,
                            "initialized Windows Media Foundation software encoder fallback"
                        );
                        return Ok((transform, selection));
                    }
                    Err(err) => {
                        errors.push(format!(
                            "software {:?}->{:?} rejected: {err}",
                            selection.input_subtype, selection.output_subtype
                        ));
                        tracing::warn!(
                            codec = codec_kind.label(),
                            hardware = selection.hardware,
                            input_subtype = ?selection.input_subtype,
                            output_subtype = ?selection.output_subtype,
                            error = %err,
                            "Windows Media Foundation software encoder candidate rejected during initialization"
                        );
                    }
                }
            }
        }
    }

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

fn create_input_sample(
    data: &[u8],
    pts_hns: i64,
    duration_hns: i64,
) -> Result<IMFSample, VideoError> {
    unsafe {
        let sample = MFCreateSample()
            .map_err(|err| VideoError::EncodeFailed(format!("MFCreateSample failed: {err}")))?;
        let buffer = MFCreateMemoryBuffer(
            u32::try_from(data.len())
                .map_err(|_| VideoError::EncodeFailed("input frame too large".into()))?,
        )
        .map_err(|err| VideoError::EncodeFailed(format!("MFCreateMemoryBuffer failed: {err}")))?;

        copy_into_buffer(&buffer, data)?;
        sample
            .AddBuffer(&buffer)
            .map_err(|err| VideoError::EncodeFailed(format!("AddBuffer failed: {err}")))?;
        sample
            .SetSampleTime(pts_hns)
            .map_err(|err| VideoError::EncodeFailed(format!("SetSampleTime failed: {err}")))?;
        sample
            .SetSampleDuration(duration_hns)
            .map_err(|err| VideoError::EncodeFailed(format!("SetSampleDuration failed: {err}")))?;
        Ok(sample)
    }
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
            match transform.ProcessOutput(0, &mut output, &mut status) {
                Ok(()) => {
                    let sample_ref = output[0].pSample.as_ref().cloned();
                    if let Some(sample) = sample_ref {
                        let data = extract_sample_bytes(&sample)?;
                        if !data.is_empty() {
                            encoded.push(EncodedFrame {
                                data,
                                codec,
                                pts: sample.GetSampleTime().unwrap_or_default()
                                    / (HNS_PER_SECOND / config.fps.max(1) as i64),
                                is_keyframe: sample_is_keyframe(&sample),
                                layer: None,
                                width: config.width,
                                height: config.height,
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
        })
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
        let expected = packed_size(self.config.width, self.config.height) as usize;
        if data.len() != expected {
            return Err(VideoError::FrameSizeMismatch {
                expected,
                actual: data.len(),
            });
        }

        let input_storage;
        let input_data = if self.selection.input_subtype == MFVideoFormat_NV12 {
            input_storage = i420_to_nv12(data, self.config.width, self.config.height);
            input_storage.as_slice()
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
                let drained = collect_output(&self.transform, &self.config, self.codec())?;
                if drained.is_empty() {
                    return Ok(drained);
                }
                return Ok(drained);
            }

            let frame_duration = HNS_PER_SECOND / self.config.fps.max(1) as i64;
            let sample = create_input_sample(input_data, pts * frame_duration, frame_duration)?;
            self.transform
                .ProcessInput(INPUT_STREAM_ID, &sample, 0)
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
