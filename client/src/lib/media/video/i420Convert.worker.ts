import { convertI420ToRgba, type FrameColorSpace } from './pulledVideoFrame';

export type I420WorkerRequest = {
  id: number;
  width: number;
  height: number;
  data: ArrayBuffer;
  byteOffset?: number;
  byteLength?: number;
  colorspace?: FrameColorSpace;
};

export type I420WorkerResponse = {
  id: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
};

self.onmessage = (event: MessageEvent<I420WorkerRequest>) => {
  const { id, width, height, data, byteOffset = 0, byteLength, colorspace } = event.data;
  const planeBytes = new Uint8Array(
    data,
    byteOffset,
    byteLength ?? data.byteLength - byteOffset,
  );
  const rgba = convertI420ToRgba(planeBytes, width, height, colorspace);
  const response: I420WorkerResponse = {
    id,
    width,
    height,
    rgba: rgba.buffer as ArrayBuffer,
  };
  self.postMessage(response, [rgba.buffer]);
};
