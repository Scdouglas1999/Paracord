/**
 * The one browser-bound step of the room's pixel work: draw a frame into a
 * small scratch canvas (cropped to 16:9, like `object-fit: cover`) and read it
 * back for `analyzeSample`. The scratch canvas is 128x72 and CPU-backed
 * (`willReadFrequently`), so a read costs a few microseconds and never stalls a
 * GPU pipeline; it is drawn a few times a second at most.
 */
import {
  analyzeSample,
  ROOM_SAMPLE_HEIGHT,
  ROOM_SAMPLE_WIDTH,
  type RoomAnalysis,
  type RoomGrade,
} from './pixels';

export interface AnalyzeOptions {
  grade: RoomGrade;
  blurSigma: number;
}

/** Analyze one frame. Returns null when the frame cannot be read (a canvas with no 2D context). */
export type FrameAnalyzer = (frame: ImageBitmap, options: AnalyzeOptions) => RoomAnalysis | null;

/** The source rectangle of `width x height` that fills a 16:9 box, centered. */
export function coverCrop(width: number, height: number): { sx: number; sy: number; sw: number; sh: number } {
  const target = ROOM_SAMPLE_WIDTH / ROOM_SAMPLE_HEIGHT;
  if (!(width > 0) || !(height > 0)) return { sx: 0, sy: 0, sw: 0, sh: 0 };
  if (width / height > target) {
    const sw = height * target;
    return { sx: (width - sw) / 2, sy: 0, sw, sh: height };
  }
  const sh = width / target;
  return { sx: 0, sy: (height - sh) / 2, sw: width, sh };
}

export function createCanvasAnalyzer(): FrameAnalyzer {
  let context: CanvasRenderingContext2D | null = null;
  return (frame, options) => {
    if (!context) {
      const canvas = document.createElement('canvas');
      canvas.width = ROOM_SAMPLE_WIDTH;
      canvas.height = ROOM_SAMPLE_HEIGHT;
      context = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
      if (!context) return null;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
    }
    const { sx, sy, sw, sh } = coverCrop(frame.width, frame.height);
    if (!(sw > 0) || !(sh > 0)) return null;
    context.clearRect(0, 0, ROOM_SAMPLE_WIDTH, ROOM_SAMPLE_HEIGHT);
    context.drawImage(frame, sx, sy, sw, sh, 0, 0, ROOM_SAMPLE_WIDTH, ROOM_SAMPLE_HEIGHT);
    const { data } = context.getImageData(0, 0, ROOM_SAMPLE_WIDTH, ROOM_SAMPLE_HEIGHT);
    return analyzeSample(data, ROOM_SAMPLE_WIDTH, ROOM_SAMPLE_HEIGHT, options);
  };
}
