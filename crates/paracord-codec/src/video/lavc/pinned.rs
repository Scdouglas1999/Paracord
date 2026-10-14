//! Page-locked ("pinned") host buffers for captured frames ([`PinnedHostPool`]).
//!
//! NVENC's upload (`hwupload_cuda`) copies the capture to the GPU. From ordinary
//! (pageable) memory the CUDA driver stages that copy through its own pinned
//! buffer with a CPU memcpy, so a 29.5 MB 5120x1440 frame costs 3.3 ms on an
//! idle machine and 9.5 to 12 ms on a loaded one (measured on the dev box's RTX
//! 4080). From pinned memory it is a DMA: about 3 ms even under that load.
//!
//! The screen capture copies each frame into a buffer from this pool on its own
//! thread, so the encode thread's upload reads pinned memory. Buffers are
//! recycled (allocating pinned memory takes milliseconds) and freed with the
//! pool. The CUDA driver is loaded at run time (`libcuda.so.1`, as libavutil
//! does); without it there is no pool, and the caller says so.

use crate::video::VideoError;
use std::ffi::{c_char, c_int, c_uint, c_void, CStr};
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Mutex};

type CuResult = c_int;
type CuDevice = c_int;
type CuContext = *mut c_void;

const RTLD_NOW: c_int = 2;
/// `CU_MEMHOSTALLOC_PORTABLE`: pinned for every CUDA context in the process,
/// including the one libavutil creates for the encoder.
const CU_MEMHOSTALLOC_PORTABLE: c_uint = 0x01;
/// Free buffers kept for reuse; more than the frames a capture holds at once
/// (the keep-latest slot, the retained frame, the frame being encoded).
const MAX_FREE_BUFFERS: usize = 6;

extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

type CuInit = unsafe extern "C" fn(c_uint) -> CuResult;
type CuDeviceGet = unsafe extern "C" fn(*mut CuDevice, c_int) -> CuResult;
type CuPrimaryRetain = unsafe extern "C" fn(*mut CuContext, CuDevice) -> CuResult;
type CuCtxPush = unsafe extern "C" fn(CuContext) -> CuResult;
type CuCtxPop = unsafe extern "C" fn(*mut CuContext) -> CuResult;
type CuMemHostAlloc = unsafe extern "C" fn(*mut *mut c_void, usize, c_uint) -> CuResult;
type CuMemFreeHost = unsafe extern "C" fn(*mut c_void) -> CuResult;
type CuPrimaryRelease = unsafe extern "C" fn(CuDevice) -> CuResult;

struct CudaApi {
    device: CuDevice,
    context: CuContext,
    ctx_push: CuCtxPush,
    ctx_pop: CuCtxPop,
    mem_host_alloc: CuMemHostAlloc,
    mem_free_host: CuMemFreeHost,
    primary_ctx_release: CuPrimaryRelease,
}

impl CudaApi {
    fn load() -> Result<Self, VideoError> {
        let fail = |what: &str| VideoError::CodecUnavailable(format!("pinned host memory: {what}"));
        unsafe {
            let lib = dlopen(c"libcuda.so.1".as_ptr(), RTLD_NOW);
            if lib.is_null() {
                return Err(fail("libcuda.so.1 not loadable"));
            }
            let sym = |name: &CStr| {
                let ptr = dlsym(lib, name.as_ptr());
                if ptr.is_null() {
                    Err(fail(&format!("{} missing", name.to_string_lossy())))
                } else {
                    Ok(ptr)
                }
            };
            // Each symbol is the driver API function of that name, with the
            // signature of its type alias (cuda.h).
            let init = std::mem::transmute::<*mut c_void, CuInit>(sym(c"cuInit")?);
            let device_get = std::mem::transmute::<*mut c_void, CuDeviceGet>(sym(c"cuDeviceGet")?);
            let primary_retain = std::mem::transmute::<*mut c_void, CuPrimaryRetain>(sym(
                c"cuDevicePrimaryCtxRetain",
            )?);
            let ctx_push =
                std::mem::transmute::<*mut c_void, CuCtxPush>(sym(c"cuCtxPushCurrent_v2")?);
            let ctx_pop = std::mem::transmute::<*mut c_void, CuCtxPop>(sym(c"cuCtxPopCurrent_v2")?);
            let mem_host_alloc =
                std::mem::transmute::<*mut c_void, CuMemHostAlloc>(sym(c"cuMemHostAlloc")?);
            let mem_free_host =
                std::mem::transmute::<*mut c_void, CuMemFreeHost>(sym(c"cuMemFreeHost")?);
            let primary_ctx_release = std::mem::transmute::<*mut c_void, CuPrimaryRelease>(sym(
                c"cuDevicePrimaryCtxRelease_v2",
            )?);
            let ret = init(0);
            if ret != 0 {
                return Err(fail(&format!("cuInit failed ({ret})")));
            }
            let mut device = 0;
            let ret = device_get(&mut device, 0);
            if ret != 0 {
                return Err(fail(&format!("cuDeviceGet(0) failed ({ret})")));
            }
            let mut context = std::ptr::null_mut();
            let ret = primary_retain(&mut context, device);
            if ret != 0 || context.is_null() {
                return Err(fail(&format!("cuDevicePrimaryCtxRetain failed ({ret})")));
            }
            Ok(Self {
                device,
                context,
                ctx_push,
                ctx_pop,
                mem_host_alloc,
                mem_free_host,
                primary_ctx_release,
            })
        }
    }

    /// Run `f` with this API's context current on the calling thread.
    unsafe fn with_context<T>(&self, f: impl FnOnce() -> T) -> T {
        (self.ctx_push)(self.context);
        let out = f();
        let mut popped = std::ptr::null_mut();
        (self.ctx_pop)(&mut popped);
        out
    }
}

struct PoolInner {
    cuda: CudaApi,
    /// Free buffers: (pointer, length).
    free: Mutex<Vec<(usize, usize)>>,
}

// Safety: the CUDA driver API is thread-safe; the free list is behind a mutex.
unsafe impl Send for PoolInner {}
unsafe impl Sync for PoolInner {}

impl Drop for PoolInner {
    fn drop(&mut self) {
        let free = std::mem::take(self.free.get_mut().unwrap_or_else(|e| e.into_inner()));
        unsafe {
            self.cuda.with_context(|| {
                for (ptr, _) in free {
                    (self.cuda.mem_free_host)(ptr as *mut c_void);
                }
            });
            (self.cuda.primary_ctx_release)(self.cuda.device);
        }
    }
}

/// A recycling pool of pinned host buffers. Cheap to clone.
#[derive(Clone)]
pub struct PinnedHostPool {
    inner: Arc<PoolInner>,
}

impl PinnedHostPool {
    /// Load the CUDA driver and retain device 0's primary context. Fails when
    /// there is no NVIDIA driver; the caller then captures to ordinary memory.
    pub fn new() -> Result<Self, VideoError> {
        Ok(Self {
            inner: Arc::new(PoolInner {
                cuda: CudaApi::load()?,
                free: Mutex::new(Vec::new()),
            }),
        })
    }

    /// A buffer of exactly `len` bytes (contents unspecified), reused when one
    /// of that size is free.
    pub fn take(&self, len: usize) -> Result<PinnedFrame, VideoError> {
        let reused = {
            let mut free = self.inner.free.lock().unwrap_or_else(|e| e.into_inner());
            free.iter()
                .position(|&(_, l)| l == len)
                .map(|i| free.swap_remove(i))
        };
        let ptr = match reused {
            Some((ptr, _)) => ptr as *mut u8,
            None => {
                let mut ptr = std::ptr::null_mut();
                let ret = unsafe {
                    self.inner.cuda.with_context(|| {
                        (self.inner.cuda.mem_host_alloc)(
                            &mut ptr,
                            len.max(1),
                            CU_MEMHOSTALLOC_PORTABLE,
                        )
                    })
                };
                if ret != 0 || ptr.is_null() {
                    return Err(VideoError::EncodeFailed(format!(
                        "cuMemHostAlloc({len}) failed ({ret})"
                    )));
                }
                ptr as *mut u8
            }
        };
        Ok(PinnedFrame {
            ptr,
            len,
            pool: self.inner.clone(),
        })
    }
}

/// One pinned buffer; returns to its pool when dropped.
pub struct PinnedFrame {
    ptr: *mut u8,
    len: usize,
    pool: Arc<PoolInner>,
}

// Safety: the buffer is exclusively owned by this value.
unsafe impl Send for PinnedFrame {}
unsafe impl Sync for PinnedFrame {}

impl Deref for PinnedFrame {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl DerefMut for PinnedFrame {
    fn deref_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
    }
}

impl Drop for PinnedFrame {
    fn drop(&mut self) {
        let mut free = self.pool.free.lock().unwrap_or_else(|e| e.into_inner());
        if free.len() < MAX_FREE_BUFFERS {
            free.push((self.ptr as usize, self.len));
            return;
        }
        drop(free);
        unsafe {
            self.pool.cuda.with_context(|| {
                (self.pool.cuda.mem_free_host)(self.ptr as *mut c_void);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an NVIDIA driver"]
    fn pinned_buffers_are_reused() {
        let pool = PinnedHostPool::new().expect("CUDA driver");
        let mut first = pool.take(1 << 20).unwrap();
        first[0] = 7;
        let ptr = first.as_ptr();
        drop(first);
        let second = pool.take(1 << 20).unwrap();
        assert_eq!(second.as_ptr(), ptr);
        assert_eq!(second.len(), 1 << 20);
    }
}
