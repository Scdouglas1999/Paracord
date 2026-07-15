use std::{
    mem::size_of,
    sync::{
        atomic::{AtomicBool, AtomicU8},
        mpsc::{self, sync_channel, SyncSender},
    },
    thread::JoinHandle,
    time::{Duration, SystemTime},
};

use pipewire as pw;
use pw::{
    context::Context,
    main_loop::MainLoop,
    properties::properties,
    spa::{
        self,
        param::{
            format::{FormatProperties, MediaSubtype, MediaType},
            video::VideoFormat,
            ParamType,
        },
        pod::{Pod, Property},
        sys::{
            SPA_META_Header, SPA_PARAM_META_size, SPA_PARAM_META_type,
        },
        utils::{Direction, SpaTypes},
    },
    stream::{StreamRef, StreamState},
};

use crate::{
    capturer::Options,
    frame::{BGRxFrame, Frame, RGBFrame, RGBxFrame, VideoFrame, XBGRFrame},
};

use self::{error::LinCapError, portal::ScreenCastPortal};

mod error;
mod portal;

static CAPTURER_STATE: AtomicU8 = AtomicU8::new(0);
static STREAM_STATE_CHANGED_TO_ERROR: AtomicBool = AtomicBool::new(false);

/// Master gate for DMA-BUF (zero-copy) capture negotiation (D1/D3).
///
/// When `true` the PipeWire stream additionally offers `SPA_DATA_DmaBuf`
/// buffers with modifier negotiation and [`process_callback`] exports the
/// dma-buf `(fd, stride, offset, modifier, format)` for the encoder to `hwmap`
/// into VAAPI (see `paracord-codec`'s `video::lavc::dmabuf`). When `false` the
/// stream offers SHM formats only and behaves exactly as before — one
/// deterministic path, no silent fallback.
///
/// It is `false` because two pieces outside this engine's owned files must land
/// first (route selection is fixed at stream start, D3):
///   1. **Carrier.** `scap::frame::VideoFrame` has no dma-buf variant, so an
///      exported descriptor cannot leave this engine through scap's public API.
///   2. **Modifier fixation + buffer lifetime.** A complete offer needs the
///      two-round DONT_FIXATE modifier handshake (re-negotiating EnumFormat with
///      the server-chosen modifier), and the capture loop must hold a PipeWire
///      buffer un-queued until the encode that imports its dma-buf completes.
/// The exact offer that gets wired in once those land is specified in the note
/// above [`pipewire_capturer`]; today the SHM offer is byte-for-byte unchanged.
const DMABUF_NEGOTIATION_ENABLED: bool = false;

/// A compositor dma-buf frame exported from a `SPA_DATA_DmaBuf` PipeWire buffer:
/// the zero-copy hand-off the encoder imports instead of a CPU `Vec<u8>`.
///
/// This mirrors the descriptor `paracord-codec::video::lavc::dmabuf` consumes.
/// It is produced by [`process_callback`] on the dma-buf route; until the scap
/// `Frame` carrier exists it has nowhere to travel, which is why the route is
/// gated off (see [`DMABUF_NEGOTIATION_ENABLED`]).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct DmaBufExport {
    pub fd: i64,
    pub offset: u32,
    pub stride: i32,
    pub modifier: u64,
    /// Negotiated `VideoFormat` as its raw SPA id (mapped to a DRM fourcc by the
    /// import side).
    pub spa_format: u32,
    pub width: i32,
    pub height: i32,
    pub display_time: SystemTime,
}

#[derive(Clone)]
struct ListenerUserData {
    pub tx: mpsc::Sender<Frame>,
    pub format: spa::param::video::VideoInfoRaw,
}

fn param_changed_callback(
    _stream: &StreamRef,
    user_data: &mut ListenerUserData,
    id: u32,
    param: Option<&Pod>,
) {
    let Some(param) = param else {
        return;
    };
    if id != pw::spa::param::ParamType::Format.as_raw() {
        return;
    }
    let (media_type, media_subtype) = match pw::spa::param::format_utils::parse_format(param) {
        Ok(v) => v,
        Err(_) => return,
    };

    if media_type != MediaType::Video || media_subtype != MediaSubtype::Raw {
        return;
    }

    user_data
        .format
        .parse(param)
        // TODO: Tell library user of the error
        .expect("Failed to parse format parameter");
}

fn state_changed_callback(
    _stream: &StreamRef,
    _user_data: &mut ListenerUserData,
    _old: StreamState,
    new: StreamState,
) {
    match new {
        StreamState::Error(e) => {
            eprintln!("pipewire: State changed to error({e})");
            STREAM_STATE_CHANGED_TO_ERROR.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        _ => {}
    }
}

fn process_callback(stream: &StreamRef, user_data: &mut ListenerUserData) {
    let buffer = unsafe { stream.dequeue_raw_buffer() };
    if !buffer.is_null() {
        'outside: {
            let buffer = unsafe { (*buffer).buffer };
            if buffer.is_null() {
                break 'outside;
            }
            // The SPA header pts is on an unspecified (usually monotonic) clock,
            // so it can't be mapped to SystemTime; capture wall time on arrival
            // like the win/mac engines' start-time-plus-elapsed approach.
            let display_time = SystemTime::now();

            let n_datas = unsafe { (*buffer).n_datas };
            if n_datas < 1 {
                break 'outside;
            }
            let frame_size = user_data.format.size();
            let width = frame_size.width as usize;
            let height = frame_size.height as usize;
            if width == 0 || height == 0 {
                break 'outside;
            }

            // DMA-BUF detection (D1). A `SPA_DATA_DmaBuf` buffer carries its
            // pixels behind an fd, not a mmap'd `data` pointer; the SHM copy
            // below would read a NULL pointer and silently drop the frame. On
            // the dma-buf route this is the zero-copy hand-off; export the
            // descriptor instead of copying. On the SHM route we never offer
            // dma-buf, so this is defensive: a compositor that hands dma-buf
            // anyway is a hard, loud error, never a silent black frame.
            let first_data_type = unsafe { (*(*buffer).datas).type_ };
            if first_data_type == pw::spa::sys::SPA_DATA_DmaBuf {
                handle_dmabuf_buffer(user_data, buffer, frame_size, display_time);
                break 'outside;
            }
            let bytes_per_pixel = match user_data.format.format() {
                VideoFormat::RGB => 3usize,
                _ => 4usize,
            };
            let row_bytes = width * bytes_per_pixel;
            // Use the chunk's valid size/stride, not `maxsize` (the allocation
            // size): compositors may pad rows or over-allocate, and consumers
            // expect tightly packed width*height*bpp buffers.
            let frame_data: Vec<u8> = unsafe {
                let data_ptr = (*(*buffer).datas).data as *const u8;
                if data_ptr.is_null() {
                    break 'outside;
                }
                let chunk = (*(*buffer).datas).chunk;
                let maxsize = (*(*buffer).datas).maxsize as usize;
                let (offset, valid_size, stride) = if chunk.is_null() {
                    (0usize, maxsize, row_bytes)
                } else {
                    let stride = (*chunk).stride.max(0) as usize;
                    (
                        (*chunk).offset as usize,
                        (*chunk).size as usize,
                        if stride == 0 { row_bytes } else { stride },
                    )
                };
                if offset >= maxsize {
                    break 'outside;
                }
                let available = valid_size.min(maxsize - offset);
                let src = std::slice::from_raw_parts(data_ptr.add(offset), available);
                if stride == row_bytes && available >= row_bytes * height {
                    src[..row_bytes * height].to_vec()
                } else if stride >= row_bytes && available >= stride * (height - 1) + row_bytes {
                    // Compact stride-padded rows into a tightly packed buffer.
                    let mut packed = Vec::with_capacity(row_bytes * height);
                    for row in 0..height {
                        let start = row * stride;
                        packed.extend_from_slice(&src[start..start + row_bytes]);
                    }
                    packed
                } else {
                    eprintln!(
                        "scap: dropping undersized pipewire frame ({}x{}, stride {}, {} bytes)",
                        width, height, stride, available
                    );
                    break 'outside;
                }
            };

            if let Err(e) = match user_data.format.format() {
                VideoFormat::RGBx => user_data.tx.send(Frame::Video(VideoFrame::RGBx(RGBxFrame {
                    display_time,
                    width: frame_size.width as i32,
                    height: frame_size.height as i32,
                    data: frame_data,
                }))),
                // RGBA is byte-identical to RGBx (R,G,B,then a fourth byte);
                // screen capture is opaque so the alpha is ignored. Route it
                // through the RGBx frame so the existing RGBx->BGRA swizzle
                // handles it — a compositor that negotiates RGBA (which we do
                // advertise) otherwise falls into the unsupported-format arm and
                // yields a silent black stream.
                VideoFormat::RGBA => user_data.tx.send(Frame::Video(VideoFrame::RGBx(RGBxFrame {
                    display_time,
                    width: frame_size.width as i32,
                    height: frame_size.height as i32,
                    data: frame_data,
                }))),
                VideoFormat::RGB => user_data.tx.send(Frame::Video(VideoFrame::RGB(RGBFrame {
                    display_time,
                    width: frame_size.width as i32,
                    height: frame_size.height as i32,
                    data: frame_data,
                }))),
                VideoFormat::xBGR => user_data.tx.send(Frame::Video(VideoFrame::XBGR(XBGRFrame {
                    display_time,
                    width: frame_size.width as i32,
                    height: frame_size.height as i32,
                    data: frame_data,
                }))),
                VideoFormat::BGRx => user_data.tx.send(Frame::Video(VideoFrame::BGRx(BGRxFrame {
                    display_time,
                    width: frame_size.width as i32,
                    height: frame_size.height as i32,
                    data: frame_data,
                }))),
                _ => {
                    eprintln!("scap: unsupported pipewire frame format, dropping frame");
                    Ok(())
                }
            } {
                eprintln!("{e}");
            }
        }
    } else {
        eprintln!("Out of buffers");
    }

    unsafe { stream.queue_raw_buffer(buffer) };
}

/// Export a `SPA_DATA_DmaBuf` buffer as a [`DmaBufExport`] (D1).
///
/// Reads the plane's fd, offset and stride from the SPA buffer and the
/// negotiated modifier/format from the parsed video info. On the dma-buf route
/// this descriptor is `hwmap`ped into VAAPI by the encoder with no CPU copy.
///
/// Delivery is gated: `scap::frame::VideoFrame` (outside this engine's owned
/// files) has no dma-buf variant, so there is no way to hand the descriptor to
/// the caller through scap's public `Frame` API yet. Rather than copy garbage
/// or drop silently, this fails loud — matching the no-silent-fallback rule and
/// the `DMABUF_NEGOTIATION_ENABLED` gate that keeps a dma-buf buffer from ever
/// reaching here on the SHM route.
fn handle_dmabuf_buffer(
    user_data: &ListenerUserData,
    buffer: *mut pw::spa::sys::spa_buffer,
    frame_size: pw::spa::utils::Rectangle,
    display_time: SystemTime,
) {
    let export = unsafe {
        let data = (*buffer).datas;
        let chunk = (*data).chunk;
        let (offset, stride) = if chunk.is_null() {
            (0u32, 0i32)
        } else {
            ((*chunk).offset, (*chunk).stride)
        };
        DmaBufExport {
            fd: (*data).fd,
            offset,
            stride,
            modifier: user_data.format.modifier(),
            spa_format: user_data.format.format().as_raw(),
            width: frame_size.width as i32,
            height: frame_size.height as i32,
            display_time,
        }
    };

    // No carrier for a zero-copy frame exists in scap's public API yet; refuse
    // loudly instead of pretending. When the `VideoFrame::DmaBuf` variant and
    // the buffer-lifetime hand-off land, this delivers `export` to the caller.
    let _ = &export;
    eprintln!(
        "scap: negotiated a DMA-BUF buffer (fd {}, {}x{}, stride {}, modifier {:#018x}) but \
         no dma-buf frame carrier is wired; dropping. This should be unreachable while \
         DMABUF_NEGOTIATION_ENABLED is false.",
        export.fd, export.width, export.height, export.stride, export.modifier
    );
}

// D1 negotiation offer — remaining work (deliberately NOT hand-rolled here).
//
// Turning the offer on (under `DMABUF_NEGOTIATION_ENABLED`) means adding, next
// to the SHM EnumFormat this engine already builds:
//   * a `FormatProperties::VideoModifier`
//     (`pw::spa::sys::SPA_FORMAT_VIDEO_modifier`, id 131074) property whose value
//     is a `Long` `Choice::Enum` of the supported DRM modifiers (at minimum
//     `DRM_FORMAT_MOD_LINEAR = 0`, plus the driver modifiers queried from EGL/
//     GBM), carrying the `MANDATORY | DONT_FIXATE` property flags; and
//   * a `SPA_PARAM_Buffers` param whose `SPA_PARAM_BUFFERS_dataType` value is the
//     bitmask `(1 << SPA_DATA_DmaBuf) | (1 << SPA_DATA_MemFd)`.
// The `DONT_FIXATE` flag then requires the two-round modifier handshake: on the
// first `param_changed`, re-submit EnumFormat fixated to the server-chosen
// `user_data.format.modifier()`. `DONT_FIXATE` is only exposed by libspa when
// the `v0_3_33` feature is enabled (this build does not enable it), so that flag
// + the fixation round are the concrete remainder. The property ids, the
// `VideoInfoRaw::modifier()` readback, and the `SPA_DATA_DmaBuf` export above are
// all in place and verified; only the offer serialization + fixation loop remain
// — left undone rather than shipped as unverifiable pod-builder code.

// TODO: Format negotiation
fn pipewire_capturer(
    options: Options,
    tx: mpsc::Sender<Frame>,
    ready_sender: &SyncSender<bool>,
    stream_id: u32,
) -> Result<(), LinCapError> {
    pw::init();

    // Route selection is fixed here, at stream start (D3): loudly name the path
    // so a black stream is never a silent mystery. The dma-buf route is not yet
    // reachable (see `DMABUF_NEGOTIATION_ENABLED`), so this always reports SHM.
    eprintln!(
        "scap: PipeWire capture route = {}",
        if DMABUF_NEGOTIATION_ENABLED {
            "dmabuf (zero-copy)"
        } else {
            "shm (compositor GPU -> CPU copy -> encoder)"
        }
    );

    let mainloop = MainLoop::new(None)?;
    let context = Context::new(&mainloop)?;
    let core = context.connect(None)?;

    let user_data = ListenerUserData {
        tx,
        format: Default::default(),
    };

    let stream = pw::stream::Stream::new(
        &core,
        "scap",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )?;

    let _listener = stream
        .add_local_listener_with_user_data(user_data.clone())
        .state_changed(state_changed_callback)
        .param_changed(param_changed_callback)
        .process(process_callback)
        .register()?;

    let obj = pw::spa::pod::object!(
        pw::spa::utils::SpaTypes::ObjectParamFormat,
        pw::spa::param::ParamType::EnumFormat,
        pw::spa::pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pw::spa::pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pw::spa::pod::property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            pw::spa::param::video::VideoFormat::RGB,
            pw::spa::param::video::VideoFormat::RGBA,
            pw::spa::param::video::VideoFormat::RGBx,
            pw::spa::param::video::VideoFormat::BGRx,
        ),
        pw::spa::pod::property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            pw::spa::utils::Rectangle {
                // Default
                width: 128,
                height: 128,
            },
            pw::spa::utils::Rectangle {
                // Min
                width: 1,
                height: 1,
            },
            pw::spa::utils::Rectangle {
                // Max — 8K so 5K/6K and super-ultrawide displays negotiate at
                // their native size instead of being clamped to 4096.
                width: 8192,
                height: 8192,
            }
        ),
        pw::spa::pod::property!(
            FormatProperties::VideoMaxFramerate,
            Fraction,
            pw::spa::utils::Fraction {
                num: options.fps,
                denom: 1
            }
        ),
    );

    let metas_obj = pw::spa::pod::object!(
        SpaTypes::ObjectParamMeta,
        ParamType::Meta,
        Property::new(
            SPA_PARAM_META_type,
            pw::spa::pod::Value::Id(pw::spa::utils::Id(SPA_META_Header))
        ),
        Property::new(
            SPA_PARAM_META_size,
            pw::spa::pod::Value::Int(size_of::<pw::spa::sys::spa_meta_header>() as i32)
        ),
    );

    let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(obj),
    )?
    .0
    .into_inner();
    let metas_values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(metas_obj),
    )?
    .0
    .into_inner();

    let mut params = [
        pw::spa::pod::Pod::from_bytes(&values).unwrap(),
        pw::spa::pod::Pod::from_bytes(&metas_values).unwrap(),
    ];

    stream.connect(
        Direction::Input,
        Some(stream_id),
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    )?;

    ready_sender.send(true)?;

    while CAPTURER_STATE.load(std::sync::atomic::Ordering::Relaxed) == 0 {
        std::thread::sleep(Duration::from_millis(10));
    }

    let pw_loop = mainloop.loop_();

    // User has called Capturer::start() and we start the main loop
    while CAPTURER_STATE.load(std::sync::atomic::Ordering::Relaxed) == 1
        && /* If the stream state got changed to `Error`, we exit. TODO: tell user that we exited */
          !STREAM_STATE_CHANGED_TO_ERROR.load(std::sync::atomic::Ordering::Relaxed)
    {
        pw_loop.iterate(Duration::from_millis(100));
    }

    Ok(())
}

pub struct LinuxCapturer {
    capturer_join_handle: Option<JoinHandle<Result<(), LinCapError>>>,
    // The pipewire stream is deleted when the connection is dropped.
    // That's why we keep it alive
    _connection: dbus::blocking::Connection,
}

impl LinuxCapturer {
    // TODO: Error handling
    pub fn new(options: &Options, tx: mpsc::Sender<Frame>) -> Self {
        let connection =
            dbus::blocking::Connection::new_session().expect("Failed to create dbus connection");
        let stream_id = ScreenCastPortal::new(&connection)
            .show_cursor(options.show_cursor)
            .expect("Unsupported cursor mode")
            .create_stream()
            .expect("Failed to get screencast stream")
            .pw_node_id();

        // TODO: Fix this hack
        let options = options.clone();
        let (ready_sender, ready_recv) = sync_channel(1);
        let capturer_join_handle = std::thread::spawn(move || {
            let res = pipewire_capturer(options, tx, &ready_sender, stream_id);
            if res.is_err() {
                ready_sender.send(false)?;
            }
            res
        });

        if !ready_recv.recv().expect("Failed to receive") {
            panic!("Failed to setup capturer");
        }

        Self {
            capturer_join_handle: Some(capturer_join_handle),
            _connection: connection,
        }
    }

    pub fn start_capture(&self) {
        CAPTURER_STATE.store(1, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn stop_capture(&mut self) {
        CAPTURER_STATE.store(2, std::sync::atomic::Ordering::Relaxed);
        if let Some(handle) = self.capturer_join_handle.take() {
            if let Err(e) = handle.join().expect("Failed to join capturer thread") {
                eprintln!("Error occured capturing: {e}");
            }
        }
        CAPTURER_STATE.store(0, std::sync::atomic::Ordering::Relaxed);
        STREAM_STATE_CHANGED_TO_ERROR.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

pub fn create_capturer(options: &Options, tx: mpsc::Sender<Frame>) -> LinuxCapturer {
    LinuxCapturer::new(options, tx)
}
