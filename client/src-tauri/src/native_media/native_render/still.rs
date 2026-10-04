//! Stills of what a native surface presents (Glass spec §2, §4, §5, §6).
//!
//! On the desktop app every remote video is decoded and drawn natively, so no
//! frame of it ever reaches the webview. Everything in the page that wants a
//! picture of a stream reads a still from here instead:
//!
//! - the room light and the stage's glow (a few pixels, once a second),
//! - the call pill's preview (a small picture, four times a second),
//! - the poster a video tile shows while its surface is hidden: during a stage
//!   move, under a dialog, before the hole in the page reopens,
//! - a clip's thumbnail.
//!
//! Each surface keeps a CPU copy of a recent frame: at most every
//! [`WANTED_COPY_INTERVAL_MS`] while somebody has asked for a still in the last
//! [`WANT_WINDOW_MS`], and at least every [`IDLE_COPY_INTERVAL_MS`] otherwise, so
//! a still is always at hand the moment a move starts. [`native_render_still`]
//! scales that copy to the size asked for (area-averaged, never enlarged,
//! proportions kept) and converts it to RGBA with the frame's own matrix. It
//! answers in binary, never as a JSON number array.
//!
//! Every surface `native_render_attach` creates is wrapped in a
//! [`StillSurface`]; `native_render_attach_sampler` attaches one with no toolkit
//! surface, for a stream that is sampled but not shown (the room's ambient
//! view). The dispatch layer presents to either the same way.
//!
//! [`native_render_still`]: super::native_render_still

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use paracord_codec::video::{ColorSpace, DecodedFrameHandle};

use super::{ShownNotifier, SurfaceFit, SurfaceGeometry, SurfaceId, VideoSurface};

/// A request keeps a track's copies fresh for this long.
pub const WANT_WINDOW_MS: u64 = 2_500;
/// How stale a copy may be while stills are wanted.
pub const WANTED_COPY_INTERVAL_MS: u64 = 200;
/// How stale a copy may be when nobody has asked: the poster a stage move
/// starts from is never older than this.
pub const IDLE_COPY_INTERVAL_MS: u64 = 1_000;
/// The largest still the webview may ask for, each way.
pub const MAX_STILL_EDGE: u32 = 1920;
/// Points read per output pixel at most, each way (an area average for big
/// reductions, a plain point sample when the still is near the frame's size).
const MAX_TAPS: usize = 4;

fn now_ms() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    // +1 so "never" (0) is always in the past.
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

/// A CPU copy of one presented frame: tightly packed I420.
#[derive(Clone)]
pub struct CpuFrame {
    pub data: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub colorspace: ColorSpace,
    /// Increases with every copy of this track.
    pub seq: u64,
}

/// Copy a presented frame to the CPU. Every surface this build presents to is
/// fed CPU I420 except the macOS VideoToolbox path, whose `CVPixelBuffer` is
/// read back through its IOSurface. A handle that cannot be read back is an
/// error the still reports, never a quiet blank.
fn cpu_copy(frame: &DecodedFrameHandle) -> Result<(Vec<u8>, u32, u32, ColorSpace), String> {
    match frame {
        DecodedFrameHandle::CpuI420 {
            data,
            width,
            height,
            colorspace,
        } => Ok((data.clone(), *width, *height, *colorspace)),
        #[cfg(target_os = "macos")]
        DecodedFrameHandle::CvPixelBuffer(buffer) => {
            let (data, width, height) = buffer
                .read_back_i420()
                .map_err(|err| format!("a VideoToolbox frame could not be read back: {err}"))?;
            Ok((data, width, height, buffer.colorspace()))
        }
        #[allow(unreachable_patterns)]
        other => Err(format!(
            "a still cannot be taken of a GPU-resident frame on this build ({other:?})"
        )),
    }
}

#[derive(Default)]
struct SlotState {
    frame: Option<CpuFrame>,
    /// Why the last presented frame could not be copied. Reported, never
    /// papered over.
    error: Option<String>,
}

/// One track's still slot, shared by its surface (writer) and the command (reader).
pub struct StillSlot {
    surface_id: SurfaceId,
    wanted_until_ms: AtomicU64,
    last_copy_ms: AtomicU64,
    seq: AtomicU64,
    state: Mutex<SlotState>,
}

impl StillSlot {
    fn new(surface_id: SurfaceId) -> Self {
        Self {
            surface_id,
            wanted_until_ms: AtomicU64::new(0),
            last_copy_ms: AtomicU64::new(0),
            seq: AtomicU64::new(0),
            state: Mutex::new(SlotState::default()),
        }
    }

    /// Whether a presented frame should be copied now (and claim the slot if so).
    fn due(&self, now: u64) -> bool {
        let last = self.last_copy_ms.load(Ordering::Relaxed);
        let interval = if self.wanted_until_ms.load(Ordering::Relaxed) >= now {
            WANTED_COPY_INTERVAL_MS
        } else {
            IDLE_COPY_INTERVAL_MS
        };
        // 0 is "never copied".
        if last != 0 && now.saturating_sub(last) < interval {
            return false;
        }
        self.last_copy_ms
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    }

    fn offer(&self, frame: &DecodedFrameHandle) {
        if !self.due(now_ms()) {
            return;
        }
        let result = cpu_copy(frame);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match result {
            Ok((data, width, height, colorspace)) => {
                let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
                state.frame = Some(CpuFrame {
                    data: Arc::new(data),
                    width,
                    height,
                    colorspace,
                    seq,
                });
                state.error = None;
            }
            Err(reason) => state.error = Some(reason),
        }
    }
}

/// Track key (`stream:track`) → the slot of the surface currently bound to it.
#[derive(Default)]
pub struct StillBoard {
    slots: Mutex<HashMap<String, Arc<StillSlot>>>,
}

impl StillBoard {
    /// Register a surface's slot for a track, replacing any earlier surface's.
    pub fn register(&self, track_key: &str, surface_id: SurfaceId) -> Arc<StillSlot> {
        let slot = Arc::new(StillSlot::new(surface_id));
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(track_key.to_string(), slot.clone());
        slot
    }

    /// Forget a surface's slot, unless another surface has taken the track since.
    pub fn forget(&self, track_key: &str, surface_id: SurfaceId) {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        if slots
            .get(track_key)
            .is_some_and(|slot| slot.surface_id == surface_id)
        {
            slots.remove(track_key);
        }
    }

    /// The latest copy of a track's frame, and keep its copies fresh.
    pub fn latest(&self, track_key: &str) -> Result<StillSource, String> {
        let slot = {
            let slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
            slots.get(track_key).cloned()
        };
        let Some(slot) = slot else {
            return Ok(StillSource::NoSurface);
        };
        slot.wanted_until_ms
            .store(now_ms() + WANT_WINDOW_MS, Ordering::Relaxed);
        let state = slot.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(error) = state.error.as_ref() {
            return Err(error.clone());
        }
        Ok(match state.frame.as_ref() {
            Some(frame) => StillSource::Frame(frame.clone()),
            None => StillSource::Waiting,
        })
    }
}

/// What a track has to make a still from.
pub enum StillSource {
    /// No native surface or sampler is bound to this track: nothing decodes it.
    NoSurface,
    /// Bound; no frame has been presented yet.
    Waiting,
    Frame(CpuFrame),
}

/// The process-global board (the dispatch layer presents from decode workers
/// with no Tauri state in reach).
pub fn board() -> &'static StillBoard {
    static BOARD: OnceLock<StillBoard> = OnceLock::new();
    BOARD.get_or_init(StillBoard::default)
}

pub fn track_key(stream_id: &str, track_id: &str) -> String {
    format!("{stream_id}:{track_id}")
}

/// The binary answer of `native_render_still`. Little-endian:
///
/// ```text
/// byte 0      status: 0 no surface, 1 waiting, 2 still, 3 unchanged (the
///             latest copy is the one the caller already has, `after_seq`)
/// (status 2 only)
/// bytes 4..8  width
/// bytes 8..12 height
/// bytes 12..20 seq (a new value means a newer frame)
/// bytes 20..  width * height * 4 bytes of RGBA, row-major, alpha 255
/// ```
pub const STILL_HEADER: usize = 20;
pub const STATUS_NO_SURFACE: u8 = 0;
pub const STATUS_WAITING: u8 = 1;
pub const STATUS_STILL: u8 = 2;
pub const STATUS_UNCHANGED: u8 = 3;

/// The size a still of a `width`x`height` frame takes inside `max_w`x`max_h`:
/// proportions kept, never larger than the frame, at least 1x1.
pub fn fit_size(width: u32, height: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let max_w = max_w.clamp(1, MAX_STILL_EDGE);
    let max_h = max_h.clamp(1, MAX_STILL_EDGE);
    if width == 0 || height == 0 {
        return (1, 1);
    }
    let scale = (max_w as f64 / width as f64)
        .min(max_h as f64 / height as f64)
        .min(1.0);
    let w = ((width as f64 * scale).round() as u32).clamp(1, max_w);
    let h = ((height as f64 * scale).round() as u32).clamp(1, max_h);
    (w, h)
}

/// Encode what a track has as the binary answer, scaling a frame to fit. A
/// copy the caller already has (`after_seq`) is answered `unchanged` without
/// scaling anything: a still screen share costs nothing to watch.
pub fn encode_still(
    source: &StillSource,
    max_w: u32,
    max_h: u32,
    after_seq: Option<u64>,
) -> Result<Vec<u8>, String> {
    match source {
        StillSource::NoSurface => Ok(vec![STATUS_NO_SURFACE]),
        StillSource::Waiting => Ok(vec![STATUS_WAITING]),
        StillSource::Frame(frame) if after_seq == Some(frame.seq) => Ok(vec![STATUS_UNCHANGED]),
        StillSource::Frame(frame) => {
            let (out_w, out_h) = fit_size(frame.width, frame.height, max_w, max_h);
            let mut out = vec![0u8; STILL_HEADER + (out_w * out_h * 4) as usize];
            out[0] = STATUS_STILL;
            out[4..8].copy_from_slice(&out_w.to_le_bytes());
            out[8..12].copy_from_slice(&out_h.to_le_bytes());
            out[12..20].copy_from_slice(&frame.seq.to_le_bytes());
            scale_i420_to_rgba(
                &frame.data,
                frame.width,
                frame.height,
                frame.colorspace,
                out_w,
                out_h,
                &mut out[STILL_HEADER..],
            )?;
            Ok(out)
        }
    }
}

/// Limited-range YUV → RGB with the frame's own matrix: the integer
/// coefficients the GL shader and the CPU converter use (contract C1).
fn yuv_to_rgb(y: u8, u: u8, v: u8, colorspace: ColorSpace) -> [u8; 3] {
    let (rv, gu, gv, bu) = match colorspace {
        ColorSpace::Bt709 => (459, -55, -136, 541),
        ColorSpace::Bt601 => (409, -100, -208, 516),
    };
    let c = 298 * (i32::from(y) - 16);
    let d = i32::from(u) - 128;
    let e = i32::from(v) - 128;
    let clamp = |value: i32| ((value + 128) >> 8).clamp(0, 255) as u8;
    [
        clamp(c + rv * e),
        clamp(c + gu * d + gv * e),
        clamp(c + bu * d),
    ]
}

/// Scale a tightly packed I420 frame to `out_w`x`out_h` RGBA (the whole frame,
/// stretched to exactly that size: callers keep the proportions with
/// [`fit_size`]). Each output pixel averages up to 4x4 points spread over the
/// area it covers.
pub fn scale_i420_to_rgba(
    data: &[u8],
    width: u32,
    height: u32,
    colorspace: ColorSpace,
    out_w: u32,
    out_h: u32,
    out: &mut [u8],
) -> Result<(), String> {
    if width < 2 || height < 2 {
        return Err(format!("frame too small for a still ({width}x{height})"));
    }
    let (w, h) = (width as usize, height as usize);
    // Chroma planes are half size, rounded up by some producers (the macOS
    // read-back) and down by others (the decoders); the length says which.
    // Even sizes are the same either way.
    let (cw, ch) = if data.len() >= w * h + 2 * w.div_ceil(2) * h.div_ceil(2) {
        (w.div_ceil(2), h.div_ceil(2))
    } else {
        (w / 2, h / 2)
    };
    let needed = w * h + 2 * cw * ch;
    if data.len() < needed || cw == 0 || ch == 0 {
        return Err(format!(
            "I420 frame is {} bytes, {needed} expected for {width}x{height}",
            data.len()
        ));
    }
    let (ow, oh) = (out_w as usize, out_h as usize);
    if out.len() < ow * oh * 4 {
        return Err("still buffer too small".to_string());
    }
    let (y_plane, rest) = data.split_at(w * h);
    let (u_plane, v_plane) = rest.split_at(cw * ch);
    let taps_x = w.div_ceil(ow).clamp(1, MAX_TAPS);
    let taps_y = h.div_ceil(oh).clamp(1, MAX_TAPS);
    // The source column of each tap, computed once per row of output.
    let columns: Vec<usize> = (0..ow * taps_x)
        .map(|i| (((i * 2 + 1) * w) / (ow * taps_x * 2)).min(w - 1))
        .collect();
    let n = (taps_x * taps_y) as u32;
    for oy in 0..oh {
        for ox in 0..ow {
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for ty in 0..taps_y {
                let y = ((((oy * taps_y + ty) * 2 + 1) * h) / (oh * taps_y * 2)).min(h - 1);
                let luma_row = y * w;
                let chroma_row = (y / 2).min(ch - 1) * cw;
                for tx in 0..taps_x {
                    let x = columns[ox * taps_x + tx];
                    let chroma = chroma_row + (x / 2).min(cw - 1);
                    let [pr, pg, pb] = yuv_to_rgb(
                        y_plane[luma_row + x],
                        u_plane[chroma],
                        v_plane[chroma],
                        colorspace,
                    );
                    r += u32::from(pr);
                    g += u32::from(pg);
                    b += u32::from(pb);
                }
            }
            let o = (oy * ow + ox) * 4;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
            out[o + 3] = 255;
        }
    }
    Ok(())
}

/// A native surface that also keeps the stills of what it presents.
/// `inner: None` is a sampler with nothing on screen.
pub struct StillSurface {
    inner: Option<Box<dyn VideoSurface>>,
    slot: Arc<StillSlot>,
    track_key: String,
    surface_id: SurfaceId,
}

impl StillSurface {
    pub fn wrap(
        inner: Option<Box<dyn VideoSurface>>,
        stream_id: &str,
        track_id: &str,
        surface_id: SurfaceId,
    ) -> Self {
        let track_key = track_key(stream_id, track_id);
        let slot = board().register(&track_key, surface_id);
        Self {
            inner,
            slot,
            track_key,
            surface_id,
        }
    }
}

impl VideoSurface for StillSurface {
    fn new(
        _app: &tauri::AppHandle,
        _surface_id: SurfaceId,
        _fit: SurfaceFit,
        _shown: ShownNotifier,
    ) -> Result<Self, String> {
        Err("a still surface is made with StillSurface::wrap".to_string())
    }

    fn update_geometry(&mut self, geometry: SurfaceGeometry) -> Result<(), String> {
        match self.inner.as_mut() {
            Some(inner) => inner.update_geometry(geometry),
            None => Ok(()),
        }
    }

    fn present(&mut self, frame: DecodedFrameHandle) -> Result<(), String> {
        self.slot.offer(&frame);
        match self.inner.as_mut() {
            Some(inner) => inner.present(frame),
            None => Ok(()),
        }
    }

    fn destroy(self) {}
}

impl Drop for StillSurface {
    fn drop(&mut self) {
        board().forget(&self.track_key, self.surface_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn i420(width: u32, height: u32, y: u8, u: u8, v: u8) -> Vec<u8> {
        let (w, h) = (width as usize, height as usize);
        let c = w.div_ceil(2) * h.div_ceil(2);
        let mut data = vec![y; w * h];
        data.extend(std::iter::repeat_n(u, c));
        data.extend(std::iter::repeat_n(v, c));
        data
    }

    fn cpu(width: u32, height: u32, y: u8) -> DecodedFrameHandle {
        DecodedFrameHandle::CpuI420 {
            data: i420(width, height, y, 128, 128),
            width,
            height,
            colorspace: ColorSpace::Bt709,
        }
    }

    fn read_header(bytes: &[u8]) -> (u8, u32, u32, u64) {
        let status = bytes[0];
        if status != STATUS_STILL {
            return (status, 0, 0, 0);
        }
        (
            status,
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            u64::from_le_bytes(bytes[12..20].try_into().unwrap()),
        )
    }

    #[test]
    fn a_still_keeps_the_frames_proportions_and_is_never_enlarged() {
        assert_eq!(fit_size(1280, 720, 512, 288), (512, 288));
        assert_eq!(fit_size(1280, 720, 32, 18), (32, 18));
        // A 4:3 camera in a 16:9 box: the height decides.
        assert_eq!(fit_size(640, 480, 512, 288), (384, 288));
        // A small layer asked for big: its own size.
        assert_eq!(fit_size(320, 180, 960, 540), (320, 180));
        // Degenerate asks still give a pixel.
        assert_eq!(fit_size(1280, 720, 0, 0), (1, 1));
        // Past the ceiling: clamped to it.
        assert_eq!(fit_size(3840, 2160, 9999, 9999), (1920, 1080));
    }

    #[test]
    fn a_flat_frame_scales_to_its_color() {
        // Limited-range mid gray: Y=126, U=V=128, about 128 in every channel.
        let data = i420(320, 180, 126, 128, 128);
        let mut out = vec![0u8; 32 * 18 * 4];
        scale_i420_to_rgba(&data, 320, 180, ColorSpace::Bt709, 32, 18, &mut out).unwrap();
        for pixel in out.chunks(4) {
            for &value in &pixel[..3] {
                assert!((value as i32 - 128).abs() <= 2, "got {value}");
            }
            assert_eq!(pixel[3], 255);
        }
    }

    #[test]
    fn the_frames_own_matrix_is_read() {
        // A saturated red in BT.709 limited range (Y=63, U=102, V=240).
        let data = i420(64, 36, 63, 102, 240);
        let mut out = vec![0u8; 16 * 9 * 4];
        scale_i420_to_rgba(&data, 64, 36, ColorSpace::Bt709, 16, 9, &mut out).unwrap();
        assert!(
            out[0] > 240 && out[1] < 20 && out[2] < 20,
            "{:?}",
            &out[..4]
        );
    }

    #[test]
    fn the_whole_frame_is_kept_left_to_right() {
        // Left half black, right half white: the still's first column is black,
        // its last white (nothing is cropped).
        let (w, h) = (96usize, 54usize);
        let mut data = i420(w as u32, h as u32, 16, 128, 128);
        for row in 0..h {
            for col in w / 2..w {
                data[row * w + col] = 235;
            }
        }
        let mut out = vec![0u8; 32 * 18 * 4];
        scale_i420_to_rgba(
            &data,
            w as u32,
            h as u32,
            ColorSpace::Bt709,
            32,
            18,
            &mut out,
        )
        .unwrap();
        assert!(out[0] < 5);
        assert!(out[31 * 4] > 250);
    }

    #[test]
    fn odd_sizes_read_with_either_chroma_rounding() {
        let mut out = vec![0u8; 4 * 4 * 4];
        // 5x3, chroma rounded down (2x1) as the decoders pack it.
        let floor = vec![126u8; 5 * 3 + 2 * 2];
        scale_i420_to_rgba(&floor, 5, 3, ColorSpace::Bt709, 4, 2, &mut out).unwrap();
        // Rounded up (3x2) as the macOS read-back packs it.
        let ceil = vec![126u8; 5 * 3 + 2 * 6];
        scale_i420_to_rgba(&ceil, 5, 3, ColorSpace::Bt709, 4, 2, &mut out).unwrap();
    }

    #[test]
    fn a_short_buffer_is_refused_loudly() {
        let mut out = vec![0u8; 64];
        assert!(scale_i420_to_rgba(&[0; 10], 320, 180, ColorSpace::Bt709, 4, 4, &mut out).is_err());
        assert!(scale_i420_to_rgba(&[0; 10], 1, 1, ColorSpace::Bt709, 4, 4, &mut out).is_err());
    }

    #[test]
    fn a_frame_is_copied_at_once_then_at_most_once_a_second_unless_wanted() {
        let board = StillBoard::default();
        let slot = board.register("s:screen", SurfaceId(7));
        // The first frame is always copied: a move can start any time.
        slot.offer(&cpu(64, 36, 126));
        assert_eq!(slot.seq.load(Ordering::Relaxed), 1);
        // Right after, with nobody asking: not copied again.
        slot.offer(&cpu(64, 36, 200));
        assert_eq!(slot.seq.load(Ordering::Relaxed), 1);
        // Asking marks it wanted; the answer is the copy at hand.
        let StillSource::Frame(frame) = board.latest("s:screen").unwrap() else {
            panic!("expected a frame");
        };
        assert_eq!((frame.width, frame.height, frame.seq), (64, 36, 1));
        assert_eq!(frame.data[0], 126);
    }

    #[test]
    fn a_track_with_no_surface_says_so_and_a_replaced_surface_is_not_forgotten() {
        let board = StillBoard::default();
        assert!(matches!(
            board.latest("x:screen").unwrap(),
            StillSource::NoSurface
        ));
        board.register("x:screen", SurfaceId(1));
        board.register("x:screen", SurfaceId(2));
        // The first surface going away leaves the second's slot in place.
        board.forget("x:screen", SurfaceId(1));
        assert!(matches!(
            board.latest("x:screen").unwrap(),
            StillSource::Waiting
        ));
        board.forget("x:screen", SurfaceId(2));
        assert!(matches!(
            board.latest("x:screen").unwrap(),
            StillSource::NoSurface
        ));
    }

    #[test]
    fn the_answer_is_binary_with_a_header() {
        assert_eq!(
            encode_still(&StillSource::NoSurface, 10, 10, None).unwrap(),
            vec![0]
        );
        assert_eq!(
            encode_still(&StillSource::Waiting, 10, 10, None).unwrap(),
            vec![1]
        );
        let frame = CpuFrame {
            data: Arc::new(i420(64, 36, 126, 128, 128)),
            width: 64,
            height: 36,
            colorspace: ColorSpace::Bt709,
            seq: 9,
        };
        let source = StillSource::Frame(frame);
        let bytes = encode_still(&source, 32, 32, None).unwrap();
        assert_eq!(read_header(&bytes), (STATUS_STILL, 32, 18, 9));
        assert_eq!(bytes.len(), STILL_HEADER + 32 * 18 * 4);
        // The copy the caller has already: nothing scaled, nothing sent.
        assert_eq!(
            encode_still(&source, 32, 32, Some(9)).unwrap(),
            vec![STATUS_UNCHANGED]
        );
        assert_eq!(
            read_header(&encode_still(&source, 32, 32, Some(8)).unwrap()).0,
            STATUS_STILL
        );
    }
}
