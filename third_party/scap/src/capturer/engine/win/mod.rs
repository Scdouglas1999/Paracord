use crate::{
    capturer::{Area, Options, Point, Resolution, Size},
    frame::{AudioFormat, AudioFrame, BGRAFrame, Frame, FrameType, VideoFrame},
    targets::{self, Target},
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::SystemTime;
use std::{cmp, time::Duration};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
// ── Zero-copy WGC → MFT encode input (spec §7, W1/W4) ─────────────────────
//
// COMPILE-UNVERIFIED: this module is `#[cfg(target_os = "windows")]` and cannot
// build on the Linux CI toolchain. It is reviewed line-by-line against the
// windows-rs 0.61 API surface.
//
// These D3D11 types must resolve to the SAME `windows` crate version that
// `windows-capture` 1.5 uses (0.61), because `Frame::as_raw_texture()` returns
// that crate's `ID3D11Texture2D`. scap currently pins `windows` 0.58, so the
// change notes record the required (unowned) Cargo bump: `windows` 0.58 → 0.61
// with the added features `Win32_Graphics_Direct3D11` and
// `Win32_Graphics_Dxgi_Common`.
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame as WCFrame,
    graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl},
    monitor::Monitor as WCMonitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings as WCSettings,
    },
    window::Window as WCWindow,
};

// The GPU-resident capture frame lives beside the other frame structs in
// `crate::frame` and is re-exported as `scap::frame::D3D11TextureFrame` (spec §7).
// Its `texture`/`device` COM handles come from the SAME `windows` crate version
// windows-capture uses, so `Frame::as_raw_texture()` and the encoder-owned copy
// below share one `ID3D11Texture2D` type.
use crate::frame::D3D11TextureFrame;

/// Which capture output the WGC engine produces for the session. Chosen ONCE at
/// capture start from the negotiated encoder (spec §7): the CPU BGRA readback is
/// the deterministic route for the libvpx VP9 software floor; the GPU texture
/// route feeds a hardware MFT. No per-frame or runtime switching.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WinCaptureRoute {
    /// CPU BGRA readback (`VideoFrame::BGRA`). Route for the VP9 software floor.
    CpuBgra,
    /// GPU D3D11 texture (`VideoFrame::D3D11Texture`). Route for hardware MFTs.
    GpuTexture,
}

#[derive(Debug)]
struct Capturer {
    pub tx: mpsc::Sender<Frame>,
    pub crop: Option<Area>,
    pub start_time: (i64, SystemTime),
    pub perf_freq: i64,
    /// Fixed capture route for this session (spec §7).
    route: WinCaptureRoute,
    /// Whether D3D11 multithread protection has been enabled on the capture
    /// device yet (texture route only). Enabled lazily on the first frame, when
    /// the device first becomes reachable via the WGC texture.
    multithread_protected: bool,
}

#[derive(Clone)]
enum Settings {
    Window(WCSettings<FlagStruct, WCWindow>),
    Display(WCSettings<FlagStruct, WCMonitor>),
}

pub struct WCStream {
    settings: Settings,
    capture_control: Option<CaptureControl<Capturer, Box<dyn std::error::Error + Send + Sync>>>,
    audio_stream: Option<AudioStreamHandle>,
}

impl GraphicsCaptureApiHandler for Capturer {
    type Flags = FlagStruct;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            tx: context.flags.tx,
            crop: context.flags.crop,
            start_time: (
                unsafe {
                    let mut time = 0;
                    let _ = QueryPerformanceCounter(&mut time);
                    time
                },
                SystemTime::now(),
            ),
            perf_freq: unsafe {
                let mut freq = 0;
                let _ = QueryPerformanceFrequency(&mut freq);
                freq
            },
            route: context.flags.route,
            multithread_protected: false,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WCFrame,
        _: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let elapsed = frame.timestamp().Duration - self.start_time.0;
        let display_time = self
            .start_time
            .1
            .checked_add(Duration::from_secs_f64(
                elapsed as f64 / self.perf_freq as f64,
            ))
            .unwrap();

        // Route chosen once at capture start (spec §7): the GPU texture path
        // feeds a hardware MFT; the CPU BGRA readback is the VP9-floor path.
        // No per-frame switching — a texture-route copy failure is a loud error
        // for the whole capture, never a silent drop to CPU.
        match self.route {
            WinCaptureRoute::GpuTexture => self.deliver_texture_frame(frame, display_time),
            WinCaptureRoute::CpuBgra => self.deliver_bgra_frame(frame, display_time),
        }
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        println!("Closed");
        Ok(())
    }
}

impl Capturer {
    /// CPU BGRA readback route (VP9 floor). Byte-for-byte the original engine
    /// behaviour, factored out so the route branch stays readable.
    fn deliver_bgra_frame(
        &mut self,
        frame: &mut WCFrame,
        display_time: SystemTime,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match &self.crop {
            Some(cropped_area) => {
                let start_x = cropped_area.origin.x as u32;
                let start_y = cropped_area.origin.y as u32;
                let end_x = (cropped_area.origin.x + cropped_area.size.width) as u32;
                let end_y = (cropped_area.origin.y + cropped_area.size.height) as u32;

                let mut cropped_buffer = frame
                    .buffer_crop(start_x, start_y, end_x, end_y)
                    .expect("Failed to crop buffer");

                let raw_frame_buffer = match cropped_buffer.as_nopadding_buffer() {
                    Ok(buffer) => buffer,
                    Err(_) => return Err(("Failed to get raw buffer").into()),
                };

                let bgr_frame = BGRAFrame {
                    display_time,
                    width: cropped_area.size.width as i32,
                    height: cropped_area.size.height as i32,
                    data: raw_frame_buffer.to_vec(),
                };

                let _ = self.tx.send(Frame::Video(VideoFrame::BGRA(bgr_frame)));
            }
            None => {
                let mut frame_buffer = frame.buffer().unwrap();
                let raw_frame_buffer = frame_buffer.as_raw_buffer();
                let frame_data = raw_frame_buffer.to_vec();
                let bgr_frame = BGRAFrame {
                    display_time,
                    width: frame.width() as i32,
                    height: frame.height() as i32,
                    data: frame_data,
                };

                let _ = self.tx.send(Frame::Video(VideoFrame::BGRA(bgr_frame)));
            }
        }
        Ok(())
    }

    /// GPU texture route (hardware MFT). Copies the WGC pool texture into an
    /// engine-owned texture on the same device and ships handles only — no CPU
    /// readback, no PCIe round trip (spec §7). A copy failure is a loud error
    /// for the whole capture (fail-loud, no silent drop to CPU).
    fn deliver_texture_frame(
        &mut self,
        frame: &mut WCFrame,
        display_time: SystemTime,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // The WGC pool texture — valid ONLY for the duration of this callback.
        let src: &ID3D11Texture2D = unsafe { frame.as_raw_texture() };

        // Recover the owning device + immediate context from the texture itself
        // (windows-capture keeps its device field private). In windows-rs 0.61
        // `GetDevice` / `GetImmediateContext` take no out-param and return the
        // interface by `Result` (the wrapper zeroes an internal out-slot and
        // `Type::from_abi`s it), so call them arg-less and map the error.
        let device = unsafe {
            src.GetDevice().map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                format!("WGC texture has no owning ID3D11Device: {e}").into()
            })?
        };
        self.ensure_multithread_protected(&device);
        let context = unsafe {
            device
                .GetImmediateContext()
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                    format!("capture device has no immediate context: {e}").into()
                })?
        };

        // Copy region: the crop rectangle, else the full frame. Always a boxed
        // CopySubresourceRegion so a padded pool texture (src larger than the
        // logical frame) cannot trip CopyResource's exact-dimensions rule.
        let (x, y, out_w, out_h) = match &self.crop {
            Some(area) => (
                area.origin.x as u32,
                area.origin.y as u32,
                area.size.width as u32,
                area.size.height as u32,
            ),
            None => (0, 0, frame.width(), frame.height()),
        };

        let owned =
            unsafe { copy_region_into_owned_texture(&device, &context, src, x, y, out_w, out_h) }?;

        let texture_frame = D3D11TextureFrame {
            display_time,
            width: out_w as i32,
            height: out_h as i32,
            texture: owned,
            device,
        };
        let _ = self
            .tx
            .send(Frame::Video(VideoFrame::D3D11Texture(texture_frame)));
        Ok(())
    }

    /// Enable D3D11 multithread protection on the capture device exactly once.
    /// The device is subsequently driven from the MFT's worker threads while the
    /// capture thread keeps copying into textures on it (W4). Idempotent, but we
    /// gate it so the cast/call happens only on the first frame.
    fn ensure_multithread_protected(&mut self, device: &ID3D11Device) {
        if self.multithread_protected {
            return;
        }
        if let Ok(mt) = device.cast::<ID3D11Multithread>() {
            unsafe {
                // windows-rs 0.61 takes a plain `bool` here, not a `BOOL`.
                let _ = mt.SetMultithreadProtected(true);
            }
            self.multithread_protected = true;
        }
    }
}

/// Blit a region of a WGC pool texture into a fresh engine-owned BGRA texture on
/// the same device, so the frame survives past the WGC callback (W4).
///
/// SAFETY: `src` must be a live `ID3D11Texture2D` on `device`, and `context`
/// must be that device's immediate context. Called only from inside the WGC
/// `on_frame_arrived` callback, where both hold.
unsafe fn copy_region_into_owned_texture(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    src: &ID3D11Texture2D,
    x: u32,
    y: u32,
    out_w: u32,
    out_h: u32,
) -> Result<ID3D11Texture2D, Box<dyn std::error::Error + Send + Sync>> {
    let mut src_desc = D3D11_TEXTURE2D_DESC::default();
    src.GetDesc(&mut src_desc);

    // Destination: GPU-default usage, no CPU access, bound so an MFT input
    // surface can sample/target it. Format inherited from the source (WGC
    // delivers DXGI_FORMAT_B8G8R8A8_UNORM / BGRA).
    let dst_desc = D3D11_TEXTURE2D_DESC {
        Width: out_w,
        Height: out_h,
        MipLevels: 1,
        ArraySize: 1,
        Format: src_desc.Format,
        SampleDesc: src_desc.SampleDesc,
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };

    let mut dst: Option<ID3D11Texture2D> = None;
    device
        .CreateTexture2D(&dst_desc, None, Some(&mut dst))
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
            format!("CreateTexture2D (encode input) failed: {e}").into()
        })?;
    let dst = dst.ok_or_else(|| -> Box<dyn std::error::Error + Send + Sync> {
        "CreateTexture2D returned a null texture".into()
    })?;

    let region = D3D11_BOX {
        left: x,
        top: y,
        front: 0,
        right: x + out_w,
        bottom: y + out_h,
        back: 1,
    };
    context.CopySubresourceRegion(&dst, 0, 0, 0, 0, src, 0, Some(std::ptr::from_ref(&region)));
    Ok(dst)
}

impl WCStream {
    pub fn start_capture(&mut self) {
        let cc = match &self.settings {
            Settings::Display(st) => Capturer::start_free_threaded(st.to_owned()).unwrap(),
            Settings::Window(st) => Capturer::start_free_threaded(st.to_owned()).unwrap(),
        };

        if let Some(audio_stream) = &self.audio_stream {
            let _ = audio_stream.ctrl_tx.send(AudioStreamControl::Start);
        }

        self.capture_control = Some(cc)
    }

    pub fn stop_capture(&mut self) {
        let capture_control = self.capture_control.take().unwrap();
        let _ = capture_control.stop();

        if let Some(audio_stream) = &self.audio_stream {
            let _ = audio_stream.ctrl_tx.send(AudioStreamControl::Stop);
        }
    }
}

#[derive(Clone, Debug)]
struct FlagStruct {
    pub tx: mpsc::Sender<Frame>,
    pub crop: Option<Area>,
    /// Fixed capture route for the session (spec §7), decided in
    /// [`create_capturer`] from the caller's negotiated encoder.
    pub route: WinCaptureRoute,
}

#[derive(Debug)]
pub enum CreateCapturerError {
    AudioStreamConfig(cpal::DefaultStreamConfigError),
    BuildAudioStream(cpal::BuildStreamError),
}

impl std::fmt::Display for CreateCapturerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AudioStreamConfig(err) => write!(f, "failed to configure audio stream: {err}"),
            Self::BuildAudioStream(err) => write!(f, "failed to build audio stream: {err}"),
        }
    }
}

impl std::error::Error for CreateCapturerError {}

pub fn create_capturer(
    options: &Options,
    tx: mpsc::Sender<Frame>,
) -> Result<WCStream, CreateCapturerError> {
    let target = options
        .target
        .clone()
        .unwrap_or_else(|| Target::Display(targets::get_main_display()));

    let color_format = match options.output_type {
        FrameType::BGRAFrame => ColorFormat::Bgra8,
        _ => ColorFormat::Rgba8,
    };

    let show_cursor = match options.show_cursor {
        true => CursorCaptureSettings::WithCursor,
        false => CursorCaptureSettings::WithoutCursor,
    };

    let draw_border = if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) {
        options
            .show_highlight
            .then_some(DrawBorderSettings::WithBorder)
            .unwrap_or(DrawBorderSettings::WithoutBorder)
    } else {
        DrawBorderSettings::Default
    };

    // Route decision, made ONCE here (spec §7). `options.prefer_gpu_texture` is
    // set by the caller from the negotiated encoder: true for a hardware MFT
    // (zero-copy WGC→MFT), false for the libvpx VP9 software floor (CPU BGRA).
    //
    // CONTRACT (unowned): `prefer_gpu_texture: bool` must be added to
    // `scap::capturer::Options` (`third_party/scap/src/capturer/mod.rs`). Until
    // it exists this reference will not compile — recorded in the change notes.
    let route = if options.prefer_gpu_texture {
        WinCaptureRoute::GpuTexture
    } else {
        WinCaptureRoute::CpuBgra
    };
    // Loud, one-time route log (spec §0 "chosen once, logged loudly").
    eprintln!(
        "[scap] WGC capture route selected: {:?} (prefer_gpu_texture={})",
        route, options.prefer_gpu_texture
    );

    // WGC ignores `Options::fps` unless a minimum update interval is set: the
    // default delivers frames at compositor rate (up to 144Hz+), so a "30fps"
    // capture would produce ~144 frames per second. Pin the interval so the
    // OS paces delivery to the requested frame rate.
    let min_update_interval = if options.fps > 0 {
        MinimumUpdateIntervalSettings::Custom(Duration::from_micros(
            (1_000_000u64 / u64::from(options.fps)).max(1),
        ))
    } else {
        MinimumUpdateIntervalSettings::Default
    };

    let settings = match target {
        Target::Display(display) => Settings::Display(WCSettings::new(
            WCMonitor::from_raw_hmonitor(display.raw_handle.0),
            show_cursor,
            draw_border,
            SecondaryWindowSettings::Default,
            min_update_interval,
            DirtyRegionSettings::Default,
            color_format,
            FlagStruct {
                tx: tx.clone(),
                crop: Some(get_crop_area(options)),
                route,
            },
        )),
        Target::Window(window) => Settings::Window(WCSettings::new(
            WCWindow::from_raw_hwnd(window.raw_handle.0),
            show_cursor,
            draw_border,
            SecondaryWindowSettings::Default,
            min_update_interval,
            DirtyRegionSettings::Default,
            color_format,
            FlagStruct {
                tx: tx.clone(),
                crop: Some(get_crop_area(options)),
                route,
            },
        )),
    };

    let audio_stream = if options.captures_audio {
        let (ctrl_tx, ctrl_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();

        spawn_audio_stream(tx.clone(), ready_tx, ctrl_rx);

        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => panic!("Audio spawn panicked"),
        }

        Some(AudioStreamHandle { ctrl_tx })
    } else {
        None
    };

    Ok(WCStream {
        settings,
        capture_control: None,
        audio_stream,
    })
}

pub fn get_output_frame_size(options: &Options) -> [u32; 2] {
    let crop_area = get_crop_area(options);

    let mut output_width = (crop_area.size.width) as u32;
    let mut output_height = (crop_area.size.height) as u32;

    match options.output_resolution {
        Resolution::Captured => {}
        _ => {
            let [resolved_width, resolved_height] = options
                .output_resolution
                .value((crop_area.size.width as f32) / (crop_area.size.height as f32));
            // 1280 x 853
            output_width = cmp::min(output_width, resolved_width);
            output_height = cmp::min(output_height, resolved_height);
        }
    }

    output_width -= output_width % 2;
    output_height -= output_height % 2;

    [output_width, output_height]
}

fn get_absolute_value(value: f64, _scale_factor: f64) -> f64 {
    let value = (value).floor();
    value + value % 2.0
}

pub fn get_crop_area(options: &Options) -> Area {
    let target = options
        .target
        .clone()
        .unwrap_or_else(|| Target::Display(targets::get_main_display()));

    let (width, height) = targets::get_target_dimensions(&target);

    let scale_factor = targets::get_scale_factor(&target);
    options
        .crop_area
        .as_ref()
        .map(|val| {
            // WINDOWS: limit values [input-width, input-height] = [146, 50]
            Area {
                origin: Point {
                    x: get_absolute_value(val.origin.x, scale_factor),
                    y: get_absolute_value(val.origin.y, scale_factor),
                },
                size: Size {
                    width: get_absolute_value(val.size.width, scale_factor),
                    height: get_absolute_value(val.size.height, scale_factor),
                },
            }
        })
        .unwrap_or_else(|| Area {
            origin: Point { x: 0.0, y: 0.0 },
            size: Size {
                width: width as f64,
                height: height as f64,
            },
        })
}

struct AudioStreamHandle {
    ctrl_tx: mpsc::Sender<AudioStreamControl>,
}

#[derive(Debug)]
enum AudioStreamControl {
    Start,
    Stop,
}

fn build_audio_stream(
    sample_tx: mpsc::Sender<
        Result<(Vec<u8>, cpal::InputCallbackInfo, SystemTime), cpal::StreamError>,
    >,
) -> Result<(cpal::Stream, cpal::SupportedStreamConfig), CreateCapturerError> {
    let host = cpal::default_host();
    let output_device =
        host.default_output_device()
            .ok_or(CreateCapturerError::AudioStreamConfig(
                cpal::DefaultStreamConfigError::DeviceNotAvailable,
            ))?;
    let supported_config = output_device
        .default_output_config()
        .map_err(CreateCapturerError::AudioStreamConfig)?;
    let config = supported_config.clone().into();

    let stream = output_device
        .build_input_stream_raw(
            &config,
            supported_config.sample_format(),
            {
                let sample_tx = sample_tx.clone();
                move |data, info: &cpal::InputCallbackInfo| {
                    sample_tx
                        .send(Ok((data.bytes().to_vec(), info.clone(), SystemTime::now())))
                        .unwrap();
                }
            },
            move |e| {
                let _ = sample_tx.send(Err(e));
            },
            None,
        )
        .map_err(CreateCapturerError::BuildAudioStream)?;

    Ok((stream, supported_config))
}

fn spawn_audio_stream(
    tx: Sender<Frame>,
    ready_tx: Sender<Result<(), CreateCapturerError>>,
    ctrl_rx: Receiver<AudioStreamControl>,
) {
    std::thread::spawn(move || {
        let (sample_tx, sample_rx) = mpsc::channel();

        let res = build_audio_stream(sample_tx);

        let (stream, config) = match res {
            Ok(stream) => {
                let _ = ready_tx.send(Ok(()));
                stream
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };

        let Ok(ctrl) = ctrl_rx.recv() else {
            return;
        };

        match ctrl {
            AudioStreamControl::Start => {
                stream.play().unwrap();
            }
            AudioStreamControl::Stop => {
                return;
            }
        }

        let audio_format = AudioFormat::from(config.sample_format());

        loop {
            match ctrl_rx.try_recv() {
                Ok(AudioStreamControl::Stop) => return,
                Ok(_) | Err(mpsc::TryRecvError::Empty) => {}
                Err(_) => return,
            };

            let (data, _info, timestamp) = match sample_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(data)) => data,
                Err(RecvTimeoutError::Timeout) => {
                    continue;
                }
                _ => {
                    // let _ = tx.send(Err(e));
                    return;
                }
            };

            let sample_count =
                data.len() / (audio_format.sample_size() * config.channels() as usize);
            let frame = AudioFrame::new(
                audio_format,
                config.channels(),
                false,
                data,
                sample_count,
                config.sample_rate().0,
                timestamp,
            );

            if let Err(_) = tx.send(Frame::Audio(frame)) {
                return;
            };
        }
    });
}
