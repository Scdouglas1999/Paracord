//! The room light's view of a native surface (Glass spec §4, WP-G8).
//!
//! On the `native-surface` route a stream is decoded and presented natively and
//! no frame ever reaches the webview, so the room (which tints the whole
//! interface from what is live) has nothing to sample. This module keeps a
//! tiny downsample of what a surface presents: 32×18 RGB, box-sampled from the
//! decoded I420 frame with the frame's own matrix, and hands it to JavaScript
//! through [`native_render_sample`].
//!
//! Cost is paid only while somebody asks: a sample is taken from a presented
//! frame only if [`native_render_sample`] was called for that track within the
//! last [`WANT_WINDOW_MS`], and at most every [`MIN_SAMPLE_INTERVAL_MS`]. A
//! sample reads 16 points per output pixel (9,216 reads, whatever the frame
//! size); nothing is copied or converted otherwise.
//!
//! Every surface `native_render_attach` creates is wrapped in a
//! [`SampledSurface`]; [`native_render_attach_sampler`] attaches one with no
//! toolkit surface at all, for a stream that is sampled but not shown (the
//! room's ambient view). The dispatch layer presents to either the same way.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use paracord_codec::video::{ColorSpace, DecodedFrameHandle};

use super::{SurfaceGeometry, SurfaceId, VideoSurface};

/// The grid a sample is taken at (the room's own grid, spec §4 "about 32×18").
pub const SAMPLE_WIDTH: u32 = 32;
pub const SAMPLE_HEIGHT: u32 = 18;
/// Points read per output pixel, each way.
const TAPS: u32 = 4;
/// At most five samples a second per track; the room asks at most four times.
pub const MIN_SAMPLE_INTERVAL_MS: u64 = 200;
/// A request keeps a track sampled for this long.
pub const WANT_WINDOW_MS: u64 = 2_000;

fn now_ms() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    // +1 so "never" (0) is always in the past.
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

/// One finished sample.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackSample {
    pub width: u32,
    pub height: u32,
    /// Increases with every sample of this track.
    pub seq: u64,
    /// `width * height * 3` bytes, row-major RGB.
    pub rgb: Vec<u8>,
}

/// What a surface records for its track.
#[derive(Default)]
struct SlotState {
    sample: Option<TrackSample>,
    /// Why the last presented frame could not be sampled (a GPU-resident
    /// handle this build cannot read back). Reported, never papered over.
    error: Option<String>,
}

/// One track's sample slot, shared by its surface (writer) and the command (reader).
pub struct SampleSlot {
    surface_id: SurfaceId,
    wanted_until_ms: AtomicU64,
    last_sample_ms: AtomicU64,
    seq: AtomicU64,
    state: Mutex<SlotState>,
}

impl SampleSlot {
    fn new(surface_id: SurfaceId) -> Self {
        Self {
            surface_id,
            wanted_until_ms: AtomicU64::new(0),
            last_sample_ms: AtomicU64::new(0),
            seq: AtomicU64::new(0),
            state: Mutex::new(SlotState::default()),
        }
    }

    /// Whether a presented frame should be sampled now (and claim the slot if so).
    fn due(&self, now: u64) -> bool {
        if self.wanted_until_ms.load(Ordering::Relaxed) < now {
            return false;
        }
        let last = self.last_sample_ms.load(Ordering::Relaxed);
        // 0 is "never sampled".
        if last != 0 && now.saturating_sub(last) < MIN_SAMPLE_INTERVAL_MS {
            return false;
        }
        self.last_sample_ms
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    }

    fn offer(&self, frame: &DecodedFrameHandle) {
        if !self.due(now_ms()) {
            return;
        }
        let result = sample_handle(frame);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match result {
            Ok((width, height, rgb)) => {
                let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
                state.sample = Some(TrackSample {
                    width,
                    height,
                    seq,
                    rgb,
                });
                state.error = None;
            }
            Err(reason) => state.error = Some(reason),
        }
    }
}

/// Track key (`stream:track`) → the slot of the surface currently bound to it.
#[derive(Default)]
pub struct SampleBoard {
    slots: Mutex<HashMap<String, Arc<SampleSlot>>>,
}

impl SampleBoard {
    /// Register a surface's slot for a track, replacing any earlier surface's.
    pub fn register(&self, track_key: &str, surface_id: SurfaceId) -> Arc<SampleSlot> {
        let slot = Arc::new(SampleSlot::new(surface_id));
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

    /// Read (and keep wanting) a track's sample.
    pub fn read(&self, track_key: &str) -> Result<SampleResponse, String> {
        let slot = {
            let slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
            slots.get(track_key).cloned()
        };
        let Some(slot) = slot else {
            return Ok(SampleResponse::NoSurface);
        };
        slot.wanted_until_ms
            .store(now_ms() + WANT_WINDOW_MS, Ordering::Relaxed);
        let state = slot.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(error) = state.error.as_ref() {
            return Err(error.clone());
        }
        Ok(match state.sample.as_ref() {
            Some(sample) => SampleResponse::Sample {
                width: sample.width,
                height: sample.height,
                seq: sample.seq,
                rgb: sample.rgb.clone(),
            },
            None => SampleResponse::Waiting,
        })
    }
}

/// The process-global board (the dispatch layer presents from decode workers
/// with no Tauri state in reach).
pub fn board() -> &'static SampleBoard {
    static BOARD: OnceLock<SampleBoard> = OnceLock::new();
    BOARD.get_or_init(SampleBoard::default)
}

pub fn track_key(stream_id: &str, track_id: &str) -> String {
    format!("{stream_id}:{track_id}")
}

/// What [`native_render_sample`] answers.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SampleResponse {
    /// No native surface or sampler is bound to this track: nothing decodes it.
    NoSurface,
    /// Bound, and asked for; no frame has been presented since.
    Waiting,
    Sample {
        width: u32,
        height: u32,
        seq: u64,
        rgb: Vec<u8>,
    },
}

/// Downsample one decoded frame to the sample grid.
fn sample_handle(frame: &DecodedFrameHandle) -> Result<(u32, u32, Vec<u8>), String> {
    match frame {
        DecodedFrameHandle::CpuI420 {
            data,
            width,
            height,
            colorspace,
        } => sample_i420(data, *width, *height, *colorspace).map(|rgb| (SAMPLE_WIDTH, SAMPLE_HEIGHT, rgb)),
        #[allow(unreachable_patterns)]
        _ => Err(
            "the room cannot sample a GPU-resident frame on this build (only CPU I420 is read back)"
                .to_string(),
        ),
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

/// Box-sample a tightly packed I420 frame to 32×18 RGB, cropped to 16:9 in the
/// middle as the room shows it (`object-fit: cover`).
pub fn sample_i420(
    data: &[u8],
    width: u32,
    height: u32,
    colorspace: ColorSpace,
) -> Result<Vec<u8>, String> {
    if width < 2 || height < 2 {
        return Err(format!("frame too small to sample ({width}x{height})"));
    }
    let (w, h) = (width as usize, height as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let needed = w * h + 2 * cw * ch;
    if data.len() < needed {
        return Err(format!(
            "I420 frame is {} bytes, {needed} expected for {width}x{height}",
            data.len()
        ));
    }
    let (y_plane, rest) = data.split_at(w * h);
    let (u_plane, v_plane) = rest.split_at(cw * ch);

    // 16:9 crop, centered.
    let (crop_x, crop_y, crop_w, crop_h) = if w * 9 > h * 16 {
        let cw16 = h * 16 / 9;
        ((w - cw16) / 2, 0, cw16, h)
    } else {
        let ch9 = w * 9 / 16;
        (0, (h - ch9) / 2, w, ch9)
    };

    let (sw, sh) = (SAMPLE_WIDTH as usize, SAMPLE_HEIGHT as usize);
    let taps = TAPS as usize;
    let mut out = vec![0u8; sw * sh * 3];
    for oy in 0..sh {
        for ox in 0..sw {
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for ty in 0..taps {
                // Tap centers inside the cell.
                let y = crop_y + ((oy * taps + ty) * 2 + 1) * crop_h / (sh * taps * 2);
                let y = y.min(h - 1);
                for tx in 0..taps {
                    let x = crop_x + ((ox * taps + tx) * 2 + 1) * crop_w / (sw * taps * 2);
                    let x = x.min(w - 1);
                    let luma = y_plane[y * w + x];
                    let chroma = (y / 2) * cw + x / 2;
                    let [pr, pg, pb] =
                        yuv_to_rgb(luma, u_plane[chroma], v_plane[chroma], colorspace);
                    r += u32::from(pr);
                    g += u32::from(pg);
                    b += u32::from(pb);
                }
            }
            let n = (taps * taps) as u32;
            let o = (oy * sw + ox) * 3;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
        }
    }
    Ok(out)
}

/// A native surface that also keeps the room's sample of what it presents.
/// `inner: None` is a sampler with nothing on screen.
pub struct SampledSurface {
    inner: Option<Box<dyn VideoSurface>>,
    slot: Arc<SampleSlot>,
    track_key: String,
    surface_id: SurfaceId,
}

impl SampledSurface {
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

impl VideoSurface for SampledSurface {
    fn new(
        _app: &tauri::AppHandle,
        _surface_id: SurfaceId,
        _fit: super::SurfaceFit,
    ) -> Result<Self, String> {
        Err("a sampled surface is made with SampledSurface::wrap".to_string())
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

impl Drop for SampledSurface {
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

    #[test]
    fn samples_a_flat_frame_to_its_color() {
        // Limited-range mid gray: Y=126, U=V=128 → about 128 in every channel.
        let rgb = sample_i420(&i420(320, 180, 126, 128, 128), 320, 180, ColorSpace::Bt709).unwrap();
        assert_eq!(rgb.len(), 32 * 18 * 3);
        for value in rgb {
            assert!((value as i32 - 128).abs() <= 2, "got {value}");
        }
    }

    #[test]
    fn reads_the_frames_own_matrix() {
        // A saturated red in BT.709 limited range (Y=63, U=102, V=240).
        let rgb = sample_i420(&i420(64, 36, 63, 102, 240), 64, 36, ColorSpace::Bt709).unwrap();
        assert!(
            rgb[0] > 240 && rgb[1] < 20 && rgb[2] < 20,
            "{:?}",
            &rgb[..3]
        );
    }

    #[test]
    fn crops_to_the_middle_sixteen_by_nine() {
        // A square frame, left half black and right half white: the crop keeps
        // the middle rows, all columns.
        let (w, h) = (90usize, 90usize);
        let mut data = i420(w as u32, h as u32, 16, 128, 128);
        for row in 0..h {
            for col in w / 2..w {
                data[row * w + col] = 235;
            }
        }
        let rgb = sample_i420(&data, w as u32, h as u32, ColorSpace::Bt709).unwrap();
        assert!(rgb[0] < 5);
        assert!(rgb[(31) * 3] > 250);
    }

    #[test]
    fn refuses_a_short_buffer_loudly() {
        assert!(sample_i420(&[0; 10], 320, 180, ColorSpace::Bt709).is_err());
        assert!(sample_i420(&[0; 10], 1, 1, ColorSpace::Bt709).is_err());
    }

    #[test]
    fn samples_only_while_asked_and_at_most_five_times_a_second() {
        let board = SampleBoard::default();
        let slot = board.register("s:screen", SurfaceId(7));
        let frame = || DecodedFrameHandle::CpuI420 {
            data: i420(64, 36, 126, 128, 128),
            width: 64,
            height: 36,
            colorspace: ColorSpace::Bt709,
        };
        // Nobody asked: nothing is sampled.
        slot.offer(&frame());
        assert_eq!(slot.seq.load(Ordering::Relaxed), 0);
        assert_eq!(board.read("s:screen").unwrap(), SampleResponse::Waiting);
        // Asked: the next frame is sampled, the one right after is not.
        slot.offer(&frame());
        slot.offer(&frame());
        assert_eq!(slot.seq.load(Ordering::Relaxed), 1);
        match board.read("s:screen").unwrap() {
            SampleResponse::Sample {
                width,
                height,
                seq,
                rgb,
            } => {
                assert_eq!((width, height, seq), (32, 18, 1));
                assert_eq!(rgb.len(), 32 * 18 * 3);
            }
            other => panic!("expected a sample, got {other:?}"),
        }
    }

    #[test]
    fn a_track_with_no_surface_says_so_and_a_replaced_surface_is_not_forgotten() {
        let board = SampleBoard::default();
        assert_eq!(board.read("x:screen").unwrap(), SampleResponse::NoSurface);
        board.register("x:screen", SurfaceId(1));
        board.register("x:screen", SurfaceId(2));
        // The first surface going away leaves the second's slot in place.
        board.forget("x:screen", SurfaceId(1));
        assert_eq!(board.read("x:screen").unwrap(), SampleResponse::Waiting);
        board.forget("x:screen", SurfaceId(2));
        assert_eq!(board.read("x:screen").unwrap(), SampleResponse::NoSurface);
    }

    #[test]
    fn serializes_for_the_webview() {
        let json = serde_json::to_value(SampleResponse::NoSurface).unwrap();
        assert_eq!(json, serde_json::json!({ "status": "noSurface" }));
        let json = serde_json::to_value(SampleResponse::Sample {
            width: 1,
            height: 1,
            seq: 3,
            rgb: vec![1, 2, 3],
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "status": "sample", "width": 1, "height": 1, "seq": 3, "rgb": [1, 2, 3] })
        );
    }
}
