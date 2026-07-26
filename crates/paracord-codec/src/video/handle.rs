//! GPU-resident decoded-frame handles (spec §3.2).
//!
//! [`DecodedFrameHandle`] is the single type a native video surface consumes.
//! It carries a decoded frame in whatever memory the decode backend produced it
//! — CUDA device memory, a VAAPI surface exported as DRM-PRIME dma-bufs, a macOS
//! `CVPixelBuffer`, or a CPU I420 buffer (the software floor). The point of the
//! type is that **decoded frames never touch the CPU when the GPU decoded them**:
//! the GPU variants keep the pixels in VRAM and hand the surface backend only the
//! handles it needs to import them into a GL/Metal texture.
//!
//! Ownership rules per variant (enforced by `Drop`):
//! - `CudaNv12` retains an [`AVFrame`](ffmpeg_sys_next::AVFrame) reference so the
//!   decoder's CUDA `hw_frames_ctx` pool keeps the surface alive; freed on drop.
//! - `DmaBufNv12` owns its exported dma-buf fds and closes them on drop, and
//!   separately retains the source VAAPI surface so the decoder pool cannot
//!   recycle (overwrite) it while those fds are still in use.
//! - `CvPixelBuffer` retains the `CVPixelBufferRef` and releases it on drop.
//! - `CpuI420` owns its pixel `Vec`.
//!
//! Every variant exposes `width` / `height` / `colorspace` accessors so the
//! surface can size its texture and pick the correct YUV→RGB matrix without
//! knowing which backend produced the frame.
//!
//! This module is purely additive to the existing CPU
//! [`DecodedFrame`](crate::video::DecodedFrame) API (spec G5): the WebCodecs
//! probe path and existing tests keep using `DecodedFrame` unchanged.

use crate::video::{ColorSpace, DecodedFrame};

#[cfg(all(unix, not(target_os = "macos")))]
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd, RawFd};

/// A decoded video frame, in the memory the decode backend produced it in.
///
/// Variants are compiled in per platform/feature so a build only ever carries
/// the handles it can actually construct: the CUDA variant needs the `lavc`
/// engine, the dma-buf variant is Linux/BSD-only, the `CVPixelBuffer` variant is
/// macOS-only. `CpuI420` is always present as the software floor.
pub enum DecodedFrameHandle {
    /// NVDEC output kept in CUDA device memory (NV12), described by a retained
    /// `AVFrame` whose `hw_frames_ctx` keeps the decode pool alive. The render
    /// side maps the plane device pointers into GL textures with
    /// `cuGraphicsGLRegisterImage` + `cuMemcpy2DAsync` (device→device only).
    #[cfg(feature = "lavc")]
    CudaNv12(CudaFrame),
    /// A VAAPI surface exported as DRM-PRIME dma-bufs (NV12): owned fds plus the
    /// per-plane offset/pitch, the DRM fourcc and format modifier. The render
    /// side imports each plane with `eglCreateImageKHR(EGL_LINUX_DMA_BUF_EXT)`.
    #[cfg(all(unix, not(target_os = "macos")))]
    DmaBufNv12(DmaBufFrame),
    /// A `CVPixelBuffer` (NV12/BGRA) from a VideoToolbox decode session, wrapped
    /// in a `CMSampleBuffer` and enqueued on an `AVSampleBufferDisplayLayer`.
    #[cfg(target_os = "macos")]
    CvPixelBuffer(CvPixelBufferFrame),
    /// CPU I420 — the software floor (libvpx VP9, or the tier-2 GPU-decode →
    /// readback path chosen at surface construction, spec §3.4).
    CpuI420 {
        /// Tightly-packed I420 (Y plane, then U, then V).
        data: Vec<u8>,
        /// Frame width in pixels.
        width: u32,
        /// Frame height in pixels.
        height: u32,
        /// Matrix the luma/chroma are expressed in (selects the YUV→RGB coeffs).
        colorspace: ColorSpace,
    },
}

impl DecodedFrameHandle {
    /// Frame width in pixels.
    pub fn width(&self) -> u32 {
        match self {
            #[cfg(feature = "lavc")]
            Self::CudaNv12(f) => f.width(),
            #[cfg(all(unix, not(target_os = "macos")))]
            Self::DmaBufNv12(f) => f.width(),
            #[cfg(target_os = "macos")]
            Self::CvPixelBuffer(f) => f.width(),
            Self::CpuI420 { width, .. } => *width,
        }
    }

    /// Frame height in pixels.
    pub fn height(&self) -> u32 {
        match self {
            #[cfg(feature = "lavc")]
            Self::CudaNv12(f) => f.height(),
            #[cfg(all(unix, not(target_os = "macos")))]
            Self::DmaBufNv12(f) => f.height(),
            #[cfg(target_os = "macos")]
            Self::CvPixelBuffer(f) => f.height(),
            Self::CpuI420 { height, .. } => *height,
        }
    }

    /// The matrix the frame's luma/chroma are expressed in. The surface uses
    /// this to pick the YUV→RGB coefficients so colours match the bitstream's
    /// signalled colorspace (contract C1).
    pub fn colorspace(&self) -> ColorSpace {
        match self {
            #[cfg(feature = "lavc")]
            Self::CudaNv12(f) => f.colorspace(),
            #[cfg(all(unix, not(target_os = "macos")))]
            Self::DmaBufNv12(f) => f.colorspace(),
            #[cfg(target_os = "macos")]
            Self::CvPixelBuffer(f) => f.colorspace(),
            Self::CpuI420 { colorspace, .. } => *colorspace,
        }
    }

    /// Wrap a CPU [`DecodedFrame`] (always I420 from this engine's decoders) as a
    /// [`DecodedFrameHandle::CpuI420`]. This is the software-floor bridge used by
    /// the default [`VideoDecoder::decode_to_handles`](crate::video::decoder::VideoDecoder::decode_to_handles)
    /// so libvpx VP9 and any CPU decode feed the surface through the one handle
    /// type (spec §3.2 / task G4).
    pub fn cpu_i420_from(frame: DecodedFrame) -> Self {
        debug_assert_eq!(
            frame.pixel_format,
            crate::video::PixelFormat::I420,
            "decode_to_handles expects an I420-producing decoder on the CPU floor"
        );
        Self::CpuI420 {
            data: frame.data,
            width: frame.width,
            height: frame.height,
            colorspace: frame.colorspace,
        }
    }
}

impl From<DecodedFrame> for DecodedFrameHandle {
    fn from(frame: DecodedFrame) -> Self {
        Self::cpu_i420_from(frame)
    }
}

impl std::fmt::Debug for DecodedFrameHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let variant = match self {
            #[cfg(feature = "lavc")]
            Self::CudaNv12(_) => "CudaNv12",
            #[cfg(all(unix, not(target_os = "macos")))]
            Self::DmaBufNv12(_) => "DmaBufNv12",
            #[cfg(target_os = "macos")]
            Self::CvPixelBuffer(_) => "CvPixelBuffer",
            Self::CpuI420 { .. } => "CpuI420",
        };
        f.debug_struct("DecodedFrameHandle")
            .field("variant", &variant)
            .field("width", &self.width())
            .field("height", &self.height())
            .field("colorspace", &self.colorspace())
            .finish()
    }
}

// ── CUDA (NVDEC) handle ──────────────────────────────────────────────

/// The `AVCUDADeviceContext` layout from `libavutil/hwcontext_cuda.h`.
///
/// `ffmpeg-sys-next` does not bind this struct (it lives behind the CUDA
/// headers, which the crate's default bindgen wrapper omits — verified against
/// this host's generated `bindings.rs`), so the fields the render side needs are
/// declared here with their canonical layout. `CUcontext` / `CUstream` are
/// opaque driver pointers, so they are `*mut c_void`; `cuda_ctx` is the first
/// field, so the read is robust even if trailing fields ever change.
#[cfg(feature = "lavc")]
#[repr(C)]
struct AVCUDADeviceContext {
    /// `CUcontext` — the shared CUDA context the decode pool lives in.
    cuda_ctx: *mut std::ffi::c_void,
    /// `CUstream` — the stream decode/transfer are ordered on.
    stream: *mut std::ffi::c_void,
    /// `AVCUDADeviceContextInternal *` — never dereferenced here.
    _internal: *mut std::ffi::c_void,
}

/// NVDEC decode output kept in CUDA device memory (NV12).
///
/// Owns a cloned reference to the decoder's `AVFrame`; while it is alive the
/// frame's `hw_frames_ctx` keeps the underlying CUDA surface pool alive, so the
/// device pointers stay valid. Never copies pixels to system memory (spec §3.4
/// tier-1: no `av_hwframe_transfer_data`).
#[cfg(feature = "lavc")]
pub struct CudaFrame {
    /// A cloned reference to the decoded hardware frame (`av_frame_clone`); its
    /// `Drop` runs `av_frame_free`, releasing this reference.
    frame: *mut ffmpeg_sys_next::AVFrame,
    width: u32,
    height: u32,
    colorspace: ColorSpace,
}

// Safety: the retained AVFrame and the CUDA pool it references are only ever
// touched through `&self`/`&mut self`; the handle is moved to the render thread
// as an owned value, mirroring how the decode workers hand frames across
// threads elsewhere in the pipeline. The AVBuffer refcount is atomic.
#[cfg(feature = "lavc")]
unsafe impl Send for CudaFrame {}

#[cfg(feature = "lavc")]
impl CudaFrame {
    /// Retain a decoded NV12 CUDA frame by **cloning** its reference. The pixels
    /// stay in VRAM (no `av_hwframe_transfer_data`); the clone shares the device
    /// buffers and keeps `hw_frames_ctx` alive, so the decoder may reuse its
    /// working frame while the render side still reads this one.
    ///
    /// # Safety
    /// `src` must be a valid CUDA-format (`AV_PIX_FMT_CUDA`) `AVFrame` produced
    /// by the decoder, with a CUDA `hw_frames_ctx`.
    pub(crate) unsafe fn retain(
        src: *mut ffmpeg_sys_next::AVFrame,
        colorspace: ColorSpace,
    ) -> Result<Self, crate::video::VideoError> {
        let clone = ffmpeg_sys_next::av_frame_clone(src);
        if clone.is_null() {
            return Err(crate::video::VideoError::DecodeFailed(
                "av_frame_clone(CUDA frame) failed".into(),
            ));
        }
        Ok(Self {
            frame: clone,
            width: (*src).width as u32,
            height: (*src).height as u32,
            colorspace,
        })
    }

    /// Frame width in pixels.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Frame height in pixels.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Signalled colorspace (selects the YUV→RGB matrix).
    pub fn colorspace(&self) -> ColorSpace {
        self.colorspace
    }

    /// The shared `CUcontext` the frame's pool lives in (spec G3):
    /// `AVFrame → hw_frames_ctx → AVHWFramesContext → device_ctx →
    /// AVHWDeviceContext → hwctx (AVCUDADeviceContext) → cuda_ctx`.
    ///
    /// The render thread must make this context current (or share it) before
    /// registering GL textures with the CUDA driver API. Returns null if the
    /// frame is not a CUDA hardware frame (should never happen for a
    /// [`CudaFrame`], but null is checked rather than assumed).
    pub fn cuda_context(&self) -> *mut std::ffi::c_void {
        self.cuda_device_ctx()
            .map(|c| unsafe { (*c).cuda_ctx })
            .unwrap_or(std::ptr::null_mut())
    }

    /// The `CUstream` decode/transfer are ordered on, for the render side to
    /// order its `cuMemcpy2DAsync` against. Null if unavailable.
    pub fn cuda_stream(&self) -> *mut std::ffi::c_void {
        self.cuda_device_ctx()
            .map(|c| unsafe { (*c).stream })
            .unwrap_or(std::ptr::null_mut())
    }

    /// Walk `AVFrame → hw_frames_ctx → device_ctx → hwctx` to the CUDA device
    /// context, or `None` if any link is null.
    fn cuda_device_ctx(&self) -> Option<*const AVCUDADeviceContext> {
        use ffmpeg_sys_next as ff;
        unsafe {
            if self.frame.is_null() {
                return None;
            }
            let hw_frames_ref = (*self.frame).hw_frames_ctx;
            if hw_frames_ref.is_null() {
                return None;
            }
            let frames_ctx = (*hw_frames_ref).data as *const ff::AVHWFramesContext;
            if frames_ctx.is_null() {
                return None;
            }
            let device_ctx = (*frames_ctx).device_ctx;
            if device_ctx.is_null() {
                return None;
            }
            let hwctx = (*device_ctx).hwctx as *const AVCUDADeviceContext;
            if hwctx.is_null() {
                return None;
            }
            Some(hwctx)
        }
    }

    /// Device pointer to the NV12 Y plane (`AVFrame::data[0]`, a `CUdeviceptr`).
    pub fn y_device_ptr(&self) -> *mut u8 {
        unsafe { (*self.frame).data[0] }
    }

    /// Device pointer to the interleaved NV12 UV plane (`AVFrame::data[1]`).
    pub fn uv_device_ptr(&self) -> *mut u8 {
        unsafe { (*self.frame).data[1] }
    }

    /// Row pitch (bytes) of the Y plane (`AVFrame::linesize[0]`).
    pub fn y_pitch(&self) -> usize {
        unsafe { (*self.frame).linesize[0].max(0) as usize }
    }

    /// Row pitch (bytes) of the UV plane (`AVFrame::linesize[1]`).
    pub fn uv_pitch(&self) -> usize {
        unsafe { (*self.frame).linesize[1].max(0) as usize }
    }
}

#[cfg(feature = "lavc")]
impl Drop for CudaFrame {
    fn drop(&mut self) {
        unsafe {
            if !self.frame.is_null() {
                ffmpeg_sys_next::av_frame_free(&mut self.frame);
            }
        }
    }
}

// ── DMA-BUF (VAAPI DRM-PRIME) handle ─────────────────────────────────

/// Retains the GPU surface backing a [`DmaBufFrame`]'s exported fds, so the
/// decoder's frame pool cannot recycle (overwrite) that surface while a surface
/// backend is still importing the dma-bufs.
///
/// Under `lavc` it holds the mapped DRM-PRIME frame and a clone of the source
/// VAAPI frame; without `lavc` (unit tests, which fabricate fds directly) it is
/// an empty ZST.
#[cfg(all(unix, not(target_os = "macos")))]
#[derive(Default)]
struct SurfaceKeepAlive {
    #[cfg(feature = "lavc")]
    frames: Vec<*mut ffmpeg_sys_next::AVFrame>,
}

// Safety: the retained AVFrames are only freed once, on drop, from whichever
// thread owns the handle; the AVBuffer refcount is atomic.
#[cfg(all(unix, not(target_os = "macos")))]
unsafe impl Send for SurfaceKeepAlive {}

#[cfg(all(unix, not(target_os = "macos"), feature = "lavc"))]
impl Drop for SurfaceKeepAlive {
    fn drop(&mut self) {
        unsafe {
            for frame in &mut self.frames {
                if !frame.is_null() {
                    ffmpeg_sys_next::av_frame_free(frame);
                }
            }
        }
    }
}

/// One DRM object (a single exported dma-buf fd) backing a [`DmaBufFrame`].
///
/// The fd is owned: dropping the object (via the owning [`DmaBufFrame`]) closes
/// it exactly once. The render side reads it as a borrowed fd for
/// `eglCreateImageKHR` (EGL dups internally; the app keeps ownership).
#[cfg(all(unix, not(target_os = "macos")))]
pub struct DmaBufObjectLayout {
    fd: OwnedFd,
    /// Total size of the object in bytes.
    pub size: usize,
    /// DRM format modifier (`DRM_FORMAT_MOD_*`) describing the tiling.
    pub modifier: u64,
}

#[cfg(all(unix, not(target_os = "macos")))]
impl DmaBufObjectLayout {
    /// Build an object layout that takes ownership of `fd`.
    pub fn new(fd: OwnedFd, size: usize, modifier: u64) -> Self {
        Self { fd, size, modifier }
    }

    /// Borrow the dma-buf fd (for `eglCreateImageKHR`); ownership stays with the
    /// object, which closes it on drop.
    pub fn borrow_fd(&self) -> BorrowedFd<'_> {
        self.fd.as_fd()
    }

    /// The raw dma-buf fd. Borrowed — do not close it; the object owns it.
    pub fn raw_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
}

/// One image plane, referencing a backing object by index.
#[cfg(all(unix, not(target_os = "macos")))]
#[derive(Debug, Clone, Copy)]
pub struct DmaBufPlaneLayout {
    /// Index into [`DmaBufFrame::objects`].
    pub object_index: usize,
    /// Byte offset of the plane within its object.
    pub offset: u32,
    /// Row pitch (stride) of the plane in bytes.
    pub pitch: u32,
}

/// A VAAPI surface exported as DRM-PRIME dma-bufs (NV12), owning its fds.
///
/// Produced by the lavc decoder's GPU-output VAAPI path
/// ([`from_vaapi_export`](Self::from_vaapi_export)); consumed by the Linux
/// native surface, which imports each plane into a GL texture via
/// `eglCreateImageKHR(EGL_LINUX_DMA_BUF_EXT)`. Dropping the handle closes every
/// backing fd exactly once and releases the retained source surface.
#[cfg(all(unix, not(target_os = "macos")))]
pub struct DmaBufFrame {
    width: u32,
    height: u32,
    colorspace: ColorSpace,
    /// DRM fourcc (`DRM_FORMAT_*`) of the exported layer (e.g. NV12).
    fourcc: u32,
    objects: Vec<DmaBufObjectLayout>,
    planes: Vec<DmaBufPlaneLayout>,
    _keepalive: SurfaceKeepAlive,
}

// Safety: the (lavc-only) retained AVFrames in `_keepalive` are freed once on
// drop; every other field is `Send`. Moving the handle to the render thread is
// sound, mirroring `CudaFrame`.
#[cfg(all(unix, not(target_os = "macos")))]
unsafe impl Send for DmaBufFrame {}

#[cfg(all(unix, not(target_os = "macos")))]
impl DmaBufFrame {
    /// Assemble a dma-buf frame from its exported objects and planes, owning
    /// every object's fd (closed on drop) with no retained backing surface. Used
    /// by tests and by callers that manage surface lifetime themselves; the
    /// VAAPI decode path uses [`from_vaapi_export`](Self::from_vaapi_export)
    /// instead, which also pins the source surface.
    pub fn new(
        width: u32,
        height: u32,
        colorspace: ColorSpace,
        fourcc: u32,
        objects: Vec<DmaBufObjectLayout>,
        planes: Vec<DmaBufPlaneLayout>,
    ) -> Self {
        Self {
            width,
            height,
            colorspace,
            fourcc,
            objects,
            planes,
            _keepalive: SurfaceKeepAlive::default(),
        }
    }

    /// Frame width in pixels.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Frame height in pixels.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Signalled colorspace (selects the YUV→RGB matrix).
    pub fn colorspace(&self) -> ColorSpace {
        self.colorspace
    }

    /// DRM fourcc (`DRM_FORMAT_*`) of the exported layer.
    pub fn fourcc(&self) -> u32 {
        self.fourcc
    }

    /// The backing dma-buf objects (owned fds + size + modifier).
    pub fn objects(&self) -> &[DmaBufObjectLayout] {
        &self.objects
    }

    /// The image planes (each references a backing object by index).
    pub fn planes(&self) -> &[DmaBufPlaneLayout] {
        &self.planes
    }

    /// Export a decoded VAAPI surface as DRM-PRIME dma-bufs (spec §3.2 G2).
    ///
    /// Maps the surface to an `AV_PIX_FMT_DRM_PRIME` frame via `av_hwframe_map`,
    /// then **dups** each exported object fd into an [`OwnedFd`] this handle
    /// closes on drop (the "fds owned by the handle" contract), while retaining
    /// both the mapped frame (owner of the original fds) and a clone of the
    /// source VAAPI frame (pins the surface so the decoder pool cannot overwrite
    /// it). The dups and originals have independent lifetimes, so there is no
    /// double-close.
    ///
    /// Runs on hardware only (VAAPI decode); reviewed line-by-line, not
    /// exercised by CI (spec §8). A map/dup failure is a decode error, never a
    /// fallback (spec §3.7).
    ///
    /// # Safety
    /// `src` must be a valid VAAPI-format (`AV_PIX_FMT_VAAPI`) `AVFrame` produced
    /// by the decoder.
    #[cfg(feature = "lavc")]
    pub(crate) unsafe fn from_vaapi_export(
        src: *mut ffmpeg_sys_next::AVFrame,
        colorspace: ColorSpace,
    ) -> Result<Self, crate::video::VideoError> {
        use crate::video::lavc::av_error_text;
        use crate::video::VideoError;
        use ffmpeg_sys_next as ff;
        use std::ffi::c_int;

        // Retain the source surface so the decoder pool cannot reuse it in place
        // while we hold exported fds to its memory.
        let src_clone = ff::av_frame_clone(src);
        if src_clone.is_null() {
            return Err(VideoError::DecodeFailed(
                "av_frame_clone(VAAPI frame) failed".into(),
            ));
        }

        // Map the VAAPI surface to a DRM-PRIME descriptor (exports dma-buf fds).
        let dst = ff::av_frame_alloc();
        if dst.is_null() {
            let mut src_clone = src_clone;
            ff::av_frame_free(&mut src_clone);
            return Err(VideoError::DecodeFailed(
                "av_frame_alloc(DRM-PRIME) failed".into(),
            ));
        }
        (*dst).format = ff::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as c_int;
        let ret = ff::av_hwframe_map(dst, src_clone, ff::AV_HWFRAME_MAP_READ as c_int);
        if ret < 0 {
            let mut dst = dst;
            let mut src_clone = src_clone;
            ff::av_frame_free(&mut dst);
            ff::av_frame_free(&mut src_clone);
            return Err(VideoError::DecodeFailed(format!(
                "av_hwframe_map(VAAPI→DRM_PRIME) failed: {}",
                av_error_text(ret)
            )));
        }

        // From here on `dst` and `src_clone` are owned by the keep-alive so any
        // early return frees them via that vector's Drop.
        let keepalive = SurfaceKeepAlive {
            frames: vec![dst, src_clone],
        };

        let desc = (*dst).data[0] as *const ff::AVDRMFrameDescriptor;
        if desc.is_null() {
            drop(keepalive);
            return Err(VideoError::DecodeFailed(
                "DRM-PRIME map produced no frame descriptor".into(),
            ));
        }

        // Own an independent dup of each exported object fd. `try_clone_to_owned`
        // dups with close-on-exec; the originals stay owned by `dst` (its free
        // callback closes them), our dups close on this handle's drop.
        let nb_objects = (*desc).nb_objects.clamp(0, 4) as usize;
        let mut objects = Vec::with_capacity(nb_objects);
        for i in 0..nb_objects {
            let raw = (*desc).objects[i].fd;
            let dup = match BorrowedFd::borrow_raw(raw).try_clone_to_owned() {
                Ok(dup) => dup,
                Err(err) => {
                    drop(keepalive);
                    return Err(VideoError::DecodeFailed(format!(
                        "dup exported dma-buf fd failed: {err}"
                    )));
                }
            };
            objects.push(DmaBufObjectLayout::new(
                dup,
                (*desc).objects[i].size,
                (*desc).objects[i].format_modifier,
            ));
        }

        // Planes come from layer 0 (NV12 = 2 planes over 1 or 2 objects).
        let mut fourcc = 0u32;
        let mut planes = Vec::new();
        if (*desc).nb_layers >= 1 {
            let layer = &(*desc).layers[0];
            fourcc = layer.format;
            let nb_planes = layer.nb_planes.clamp(0, 4) as usize;
            for i in 0..nb_planes {
                planes.push(DmaBufPlaneLayout {
                    object_index: layer.planes[i].object_index as usize,
                    offset: layer.planes[i].offset as u32,
                    pitch: layer.planes[i].pitch as u32,
                });
            }
        }

        Ok(Self {
            width: (*src).width as u32,
            height: (*src).height as u32,
            colorspace,
            fourcc,
            objects,
            planes,
            _keepalive: keepalive,
        })
    }
}

// `OwnedFd` closes each backing fd exactly once when the `objects` Vec drops, and
// `SurfaceKeepAlive`'s Drop frees the retained surface, so dropping a
// `DmaBufFrame` releases everything — no manual `Drop` impl on the frame itself.

// ── macOS CVPixelBuffer handle ───────────────────────────────────────

/// A retained `CVPixelBufferRef` from a VideoToolbox decode (macOS only).
///
/// Review-only on this toolchain (macOS frameworks do not compile on Linux). The
/// VideoToolbox decoder produces the pixel buffer; this handle retains it
/// (`CFRetain`) so it outlives the decode session's output callback, and
/// releases it (`CFRelease`) on drop. The macOS surface wraps it in a
/// `CMSampleBuffer` and enqueues it on an `AVSampleBufferDisplayLayer`.
#[cfg(target_os = "macos")]
pub struct CvPixelBufferFrame {
    pixel_buffer: *mut std::ffi::c_void,
    width: u32,
    height: u32,
    colorspace: ColorSpace,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(cf: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CFRelease(cf: *const std::ffi::c_void);
}

#[cfg(target_os = "macos")]
// Safety: the retained CVPixelBuffer is only touched through `&self`; the handle
// is moved to the main-thread render side as an owned value.
unsafe impl Send for CvPixelBufferFrame {}

#[cfg(target_os = "macos")]
impl CvPixelBufferFrame {
    /// Retain and wrap a `CVPixelBufferRef`. The handle holds one reference and
    /// releases it on drop.
    ///
    /// # Safety
    /// `pixel_buffer` must be a valid, non-null `CVPixelBufferRef`.
    pub unsafe fn retain(
        pixel_buffer: *mut std::ffi::c_void,
        width: u32,
        height: u32,
        colorspace: ColorSpace,
    ) -> Self {
        CFRetain(pixel_buffer);
        Self {
            pixel_buffer,
            width,
            height,
            colorspace,
        }
    }

    /// Frame width in pixels.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Frame height in pixels.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Signalled colorspace (selects the YUV→RGB matrix).
    pub fn colorspace(&self) -> ColorSpace {
        self.colorspace
    }

    /// The retained `CVPixelBufferRef`, for wrapping in a `CMSampleBuffer`. The
    /// handle keeps ownership; do not release the returned pointer.
    pub fn pixel_buffer(&self) -> *mut std::ffi::c_void {
        self.pixel_buffer
    }
}

#[cfg(target_os = "macos")]
impl Drop for CvPixelBufferFrame {
    fn drop(&mut self) {
        unsafe {
            if !self.pixel_buffer.is_null() {
                CFRelease(self.pixel_buffer);
            }
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_i420_accessors_report_stored_geometry() {
        let handle = DecodedFrameHandle::CpuI420 {
            data: vec![7u8; 320 * 180 * 3 / 2],
            width: 320,
            height: 180,
            colorspace: ColorSpace::Bt601,
        };
        assert_eq!(handle.width(), 320);
        assert_eq!(handle.height(), 180);
        assert_eq!(handle.colorspace(), ColorSpace::Bt601);
    }

    #[test]
    fn cpu_i420_from_decoded_frame_preserves_fields() {
        let frame = DecodedFrame {
            data: vec![1u8, 2, 3, 4],
            pixel_format: crate::video::PixelFormat::I420,
            width: 64,
            height: 48,
            pts: 99,
            colorspace: ColorSpace::Bt709,
        };
        // Both the explicit bridge and the `From` impl must agree.
        let handle = DecodedFrameHandle::cpu_i420_from(frame.clone());
        let via_from: DecodedFrameHandle = frame.into();
        assert_eq!(handle.width(), 64);
        assert_eq!(handle.height(), 48);
        assert_eq!(handle.colorspace(), ColorSpace::Bt709);
        assert_eq!(via_from.width(), 64);
        match handle {
            DecodedFrameHandle::CpuI420 { data, .. } => assert_eq!(data, vec![1, 2, 3, 4]),
            #[allow(unreachable_patterns)]
            _ => panic!("expected CpuI420"),
        }
    }

    // ── DMA-BUF fd ownership / close-on-drop ─────────────────────────
    #[cfg(all(unix, not(target_os = "macos")))]
    mod dmabuf_fds {
        use super::*;
        use std::fs::File;
        use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};

        /// `DRM_FORMAT_NV12` — the fourcc a VAAPI YUV 4:2:0 decode surface
        /// exports (`'N','V','1','2'` little-endian).
        const DRM_FORMAT_NV12: u32 = 0x3231_564e;

        /// A live, independent fd — a `dup` of /dev/null this test owns outright.
        /// A dup'd fd onto a file unique to this call.
        ///
        /// Deliberately not `/dev/null`: every dup of it shares one inode, so a
        /// closed-then-reused fd number would be indistinguishable from one that
        /// was never closed. A private temp file gives each fd an identity that
        /// [`fd_identity`] can check.
        fn dup_unique_file() -> (OwnedFd, (u64, u64)) {
            use std::os::unix::fs::MetadataExt;
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQ: AtomicU64 = AtomicU64::new(0);

            let path = std::env::temp_dir().join(format!(
                "paracord-fd-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let file = File::create(&path).expect("create temp file");
            let md = file.metadata().expect("stat temp file");
            let identity = (md.dev(), md.ino());
            // Unlinked immediately: the fd keeps it alive, nothing is left behind.
            let _ = std::fs::remove_file(&path);
            let dup: OwnedFd = file.try_clone().expect("dup fd").into();
            (dup, identity)
        }

        /// `(dev, ino)` of whatever `raw` currently refers to, or `None` if closed.
        fn fd_identity(raw: RawFd) -> Option<(u64, u64)> {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: borrow only; the dup we take is owned and dropped here.
            let borrowed = unsafe { BorrowedFd::borrow_raw(raw) };
            let dup = borrowed.try_clone_to_owned().ok()?;
            let md = File::from(dup).metadata().ok()?;
            Some((md.dev(), md.ino()))
        }

        /// Assert `raw` no longer refers to `identity`.
        ///
        /// Asserting the fd *number* is unused races against every other thread
        /// in the test binary: the kernel hands the lowest free descriptor to
        /// whoever asks next, so an unrelated `File::open` between the drop and
        /// the check makes a correctly-closed fd look open. Checking identity
        /// distinguishes "never closed" from "closed, then the number was
        /// reused", which is the property actually under test.
        fn assert_fd_released(raw: RawFd, identity: (u64, u64), label: &str) {
            match fd_identity(raw) {
                None => {}
                Some(now) => assert_ne!(
                    now, identity,
                    "{label} was not closed: fd {raw} still refers to the same file"
                ),
            }
        }

        /// Whether `raw` still refers to an open fd: dup it (via the kernel) and
        /// see whether that succeeds. A closed fd yields EBADF. Uses only std, so
        /// the test needs no libc dependency.
        fn fd_is_open(raw: RawFd) -> bool {
            // SAFETY: borrow only; we never close `raw` through this borrow. The
            // dup'd fd (if any) is owned and dropped immediately.
            let borrowed = unsafe { BorrowedFd::borrow_raw(raw) };
            borrowed.try_clone_to_owned().is_ok()
        }

        #[test]
        fn drop_closes_every_backing_fd() {
            let (a, id_a) = dup_unique_file();
            let (b, id_b) = dup_unique_file();
            let raw_a = a.as_raw_fd();
            let raw_b = b.as_raw_fd();
            assert_ne!(raw_a, raw_b, "two dups must be distinct fds");

            let frame = DmaBufFrame::new(
                1920,
                1080,
                ColorSpace::Bt709,
                DRM_FORMAT_NV12,
                vec![
                    DmaBufObjectLayout::new(a, 1920 * 1080, 0),
                    DmaBufObjectLayout::new(b, 1920 * 1080 / 2, 0),
                ],
                vec![
                    DmaBufPlaneLayout {
                        object_index: 0,
                        offset: 0,
                        pitch: 1920,
                    },
                    DmaBufPlaneLayout {
                        object_index: 1,
                        offset: 0,
                        pitch: 1920,
                    },
                ],
            );

            // Both fds are live while the frame owns them, and the accessors read
            // back the geometry / raw fds the render side needs.
            assert!(fd_is_open(raw_a), "fd A must be open before drop");
            assert!(fd_is_open(raw_b), "fd B must be open before drop");
            assert_eq!(frame.width(), 1920);
            assert_eq!(frame.height(), 1080);
            assert_eq!(frame.fourcc(), DRM_FORMAT_NV12);
            assert_eq!(frame.objects().len(), 2);
            assert_eq!(frame.objects()[0].raw_fd(), raw_a);
            assert_eq!(frame.objects()[1].size, 1920 * 1080 / 2);
            assert_eq!(frame.planes().len(), 2);

            drop(frame);

            // Close-on-drop: neither fd survives the handle.
            assert_fd_released(raw_a, id_a, "fd A");
            assert_fd_released(raw_b, id_b, "fd B");
        }

        #[test]
        fn owned_fd_moved_into_object_is_closed_exactly_once() {
            // Moving an OwnedFd into the layout transfers sole ownership; leaking
            // the raw fd out again lets us prove exactly one close happened.
            let (owned, identity) = dup_unique_file();
            let raw = owned.as_raw_fd();
            let layout = DmaBufObjectLayout::new(owned, 4096, 0);
            assert_eq!(layout.raw_fd(), raw);
            drop(layout);
            assert_fd_released(raw, identity, "the single owner's fd");

            // Sanity that we closed a real fd (not a bookkeeping error): a fresh
            // dup succeeds and we clean it up ourselves.
            let (probe, _) = dup_unique_file();
            let probe_raw = probe.into_raw_fd();
            // SAFETY: reclaim the leaked fd so this test closes it exactly once.
            drop(unsafe { OwnedFd::from_raw_fd(probe_raw) });
        }
    }
}
