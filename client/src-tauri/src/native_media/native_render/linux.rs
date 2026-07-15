//! Linux native-surface backend (spec §3.3): a `gtk::GLArea` per track,
//! composited as an **underlay** BELOW the reparented WebKit webview inside a
//! `gtk::Overlay`.
//!
//! # Underlay compositing (spec §3.3, 2026-07-07 revision)
//! The `Overlay`'s main child is a `gtk::Fixed` hosting the GLAreas; the
//! webview is the overlay child on top with its background cleared to
//! transparent. The DOM punches a transparent hole at each stream tile
//! (`data-native-underlay` + tile-local transparency), so the video shows
//! through while every piece of DOM chrome — control bars, badges, modals,
//! context menus — naturally renders ABOVE the video and receives input
//! first. This replaces the previous overlay-on-top design, whose GLArea both
//! hid and swallowed input from all in-tile controls (the 2026-07-07
//! invisible-and-unclickable controls bug). Underlay does **not** blank the
//! GL surface for body-portaled menus/tooltips (that hid the whole tile and
//! glued hover chrome into the stream on visibility-flip repaints). Floating
//! UI stays readable via opaque DOM paints above the hole.
//!
//! # Threading
//! Every GTK/GL call runs on the GTK main thread. The `Send` [`LinuxVideoSurface`]
//! handle holds no GTK object — only an `AppHandle` (for `run_on_main_thread`,
//! Tauri's marshaling primitive) and a keep-latest frame slot shared with the
//! render callback. The real GLArea + GL renderer live in a main-thread
//! `thread_local` keyed by [`SurfaceId`]; `present()` writes the slot and wakes a
//! `queue_render` on the main thread (spec §3.3).
//!
//! # Tier (spec §3.3/§3.4)
//! This pass lands the **tier-2 floor as the working path**: decoded frames
//! arrive as [`DecodedFrameHandle::CpuI420`] (the decoder runs in CPU-output
//! mode) and are uploaded with `glTexSubImage2D`, then drawn NV-free through an
//! I420→RGB shader with the frame's signalled colorspace matrix and a
//! rounded-rect premultiplied-alpha mask. **Still zero IPC, zero WebKit.** The
//! tier-1 GPU-interop paths (CUDA-GL / EGL-dmabuf) are **not engaged**: they
//! cannot be made sound without a live GL/CUDA session (spec §8), so per the
//! "honest tier-2 beats a broken interop" rule (§3.4) a GPU-resident handle
//! reaching `present()` is a loud error (§3.7), never a silent drop or fake.
//! The decision is logged once at host install.

use std::cell::RefCell;
use std::collections::HashMap;
use std::os::raw::{c_char, c_float, c_int, c_uchar, c_uint, c_void};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use gtk::prelude::*;
use paracord_codec::video::{ColorSpace, DecodedFrameHandle, PixelFormat};

use super::{SurfaceGeometry, SurfaceId, VideoSurface};

// ── GL scalar + entry-point types ────────────────────────────────────────────

#[allow(non_camel_case_types)]
type GLenum = c_uint;
#[allow(non_camel_case_types)]
type GLuint = c_uint;
#[allow(non_camel_case_types)]
type GLint = c_int;
#[allow(non_camel_case_types)]
type GLsizei = c_int;
#[allow(non_camel_case_types)]
type GLboolean = c_uchar;
#[allow(non_camel_case_types)]
type GLbitfield = c_uint;
#[allow(non_camel_case_types)]
type GLfloat = c_float;
#[allow(non_camel_case_types)]
type GLchar = c_char;
#[allow(non_camel_case_types)]
type GLsizeiptr = isize;

// GL enum constants (core 3.2) used by the renderer.
const GL_FRAGMENT_SHADER: GLenum = 0x8B30;
const GL_VERTEX_SHADER: GLenum = 0x8B31;
const GL_COMPILE_STATUS: GLenum = 0x8B81;
const GL_LINK_STATUS: GLenum = 0x8B82;
const GL_ARRAY_BUFFER: GLenum = 0x8892;
const GL_STATIC_DRAW: GLenum = 0x88E4;
const GL_TEXTURE_2D: GLenum = 0x0DE1;
const GL_TEXTURE0: GLenum = 0x84C0;
const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;
const GL_LINEAR: GLint = 0x2601;
const GL_TEXTURE_WRAP_S: GLenum = 0x2802;
const GL_TEXTURE_WRAP_T: GLenum = 0x2803;
const GL_CLAMP_TO_EDGE: GLint = 0x812F;
const GL_RED: GLenum = 0x1903;
const GL_R8: GLint = 0x8229;
const GL_UNSIGNED_BYTE: GLenum = 0x1401;
const GL_UNPACK_ALIGNMENT: GLenum = 0x0CF5;
const GL_FLOAT: GLenum = 0x1406;
const GL_FALSE: GLboolean = 0;
const GL_COLOR_BUFFER_BIT: GLbitfield = 0x0000_4000;
const GL_TRIANGLE_STRIP: GLenum = 0x0005;
const GL_BLEND: GLenum = 0x0BE2;
const GL_ONE: GLenum = 1;
const GL_ONE_MINUS_SRC_ALPHA: GLenum = 0x0303;

/// Dynamically-loaded GL entry points. `libGL.so.1` exports every core 3.x
/// function as a real symbol on this platform, so a direct dlopen + dlsym works
/// (no GL-loader crate exists in the tree; see the crate recon). Only ever
/// called on the GLArea's GL thread with a current context.
#[allow(non_snake_case)]
struct GlFns {
    _library: libloading::Library,
    glCreateShader: unsafe extern "C" fn(GLenum) -> GLuint,
    glShaderSource: unsafe extern "C" fn(GLuint, GLsizei, *const *const GLchar, *const GLint),
    glCompileShader: unsafe extern "C" fn(GLuint),
    glGetShaderiv: unsafe extern "C" fn(GLuint, GLenum, *mut GLint),
    glGetShaderInfoLog: unsafe extern "C" fn(GLuint, GLsizei, *mut GLsizei, *mut GLchar),
    glCreateProgram: unsafe extern "C" fn() -> GLuint,
    glAttachShader: unsafe extern "C" fn(GLuint, GLuint),
    glLinkProgram: unsafe extern "C" fn(GLuint),
    glGetProgramiv: unsafe extern "C" fn(GLuint, GLenum, *mut GLint),
    glGetProgramInfoLog: unsafe extern "C" fn(GLuint, GLsizei, *mut GLsizei, *mut GLchar),
    glUseProgram: unsafe extern "C" fn(GLuint),
    glGenVertexArrays: unsafe extern "C" fn(GLsizei, *mut GLuint),
    glBindVertexArray: unsafe extern "C" fn(GLuint),
    glGenBuffers: unsafe extern "C" fn(GLsizei, *mut GLuint),
    glBindBuffer: unsafe extern "C" fn(GLenum, GLuint),
    glBufferData: unsafe extern "C" fn(GLenum, GLsizeiptr, *const c_void, GLenum),
    glVertexAttribPointer:
        unsafe extern "C" fn(GLuint, GLint, GLenum, GLboolean, GLsizei, *const c_void),
    glEnableVertexAttribArray: unsafe extern "C" fn(GLuint),
    glGetAttribLocation: unsafe extern "C" fn(GLuint, *const GLchar) -> GLint,
    glGetUniformLocation: unsafe extern "C" fn(GLuint, *const GLchar) -> GLint,
    glUniform1i: unsafe extern "C" fn(GLint, GLint),
    glUniform1f: unsafe extern "C" fn(GLint, GLfloat),
    glUniform2f: unsafe extern "C" fn(GLint, GLfloat, GLfloat),
    glUniformMatrix3fv: unsafe extern "C" fn(GLint, GLsizei, GLboolean, *const GLfloat),
    glGenTextures: unsafe extern "C" fn(GLsizei, *mut GLuint),
    glBindTexture: unsafe extern "C" fn(GLenum, GLuint),
    glTexParameteri: unsafe extern "C" fn(GLenum, GLenum, GLint),
    glTexImage2D: unsafe extern "C" fn(
        GLenum,
        GLint,
        GLint,
        GLsizei,
        GLsizei,
        GLint,
        GLenum,
        GLenum,
        *const c_void,
    ),
    glTexSubImage2D: unsafe extern "C" fn(
        GLenum,
        GLint,
        GLint,
        GLint,
        GLsizei,
        GLsizei,
        GLenum,
        GLenum,
        *const c_void,
    ),
    glPixelStorei: unsafe extern "C" fn(GLenum, GLint),
    glActiveTexture: unsafe extern "C" fn(GLenum),
    glClear: unsafe extern "C" fn(GLbitfield),
    glClearColor: unsafe extern "C" fn(GLfloat, GLfloat, GLfloat, GLfloat),
    glViewport: unsafe extern "C" fn(GLint, GLint, GLsizei, GLsizei),
    glDrawArrays: unsafe extern "C" fn(GLenum, GLint, GLsizei),
    glEnable: unsafe extern "C" fn(GLenum),
    glBlendFunc: unsafe extern "C" fn(GLenum, GLenum),
}

// Safety: the fields are plain function pointers (address-only, `Send + Sync`)
// and the `Library` keeps them resolvable; every call is guarded to the GL
// thread by the render callback / GLArea context currency.
unsafe impl Send for GlFns {}
unsafe impl Sync for GlFns {}

impl GlFns {
    fn load() -> Result<Self, String> {
        // Keep the library alive for the process lifetime so the resolved
        // pointers stay valid.
        let library = unsafe { libloading::Library::new("libGL.so.1") }
            .map_err(|e| format!("dlopen libGL.so.1 failed: {e}"))?;

        macro_rules! sym {
            ($name:literal, $ty:ty) => {{
                let symbol: libloading::Symbol<$ty> =
                    unsafe { library.get(concat!($name, "\0").as_bytes()) }
                        .map_err(|e| format!("dlsym {} failed: {e}", $name))?;
                *symbol
            }};
        }

        Ok(GlFns {
            glCreateShader: sym!("glCreateShader", unsafe extern "C" fn(GLenum) -> GLuint),
            glShaderSource: sym!(
                "glShaderSource",
                unsafe extern "C" fn(GLuint, GLsizei, *const *const GLchar, *const GLint)
            ),
            glCompileShader: sym!("glCompileShader", unsafe extern "C" fn(GLuint)),
            glGetShaderiv: sym!(
                "glGetShaderiv",
                unsafe extern "C" fn(GLuint, GLenum, *mut GLint)
            ),
            glGetShaderInfoLog: sym!(
                "glGetShaderInfoLog",
                unsafe extern "C" fn(GLuint, GLsizei, *mut GLsizei, *mut GLchar)
            ),
            glCreateProgram: sym!("glCreateProgram", unsafe extern "C" fn() -> GLuint),
            glAttachShader: sym!("glAttachShader", unsafe extern "C" fn(GLuint, GLuint)),
            glLinkProgram: sym!("glLinkProgram", unsafe extern "C" fn(GLuint)),
            glGetProgramiv: sym!(
                "glGetProgramiv",
                unsafe extern "C" fn(GLuint, GLenum, *mut GLint)
            ),
            glGetProgramInfoLog: sym!(
                "glGetProgramInfoLog",
                unsafe extern "C" fn(GLuint, GLsizei, *mut GLsizei, *mut GLchar)
            ),
            glUseProgram: sym!("glUseProgram", unsafe extern "C" fn(GLuint)),
            glGenVertexArrays: sym!(
                "glGenVertexArrays",
                unsafe extern "C" fn(GLsizei, *mut GLuint)
            ),
            glBindVertexArray: sym!("glBindVertexArray", unsafe extern "C" fn(GLuint)),
            glGenBuffers: sym!("glGenBuffers", unsafe extern "C" fn(GLsizei, *mut GLuint)),
            glBindBuffer: sym!("glBindBuffer", unsafe extern "C" fn(GLenum, GLuint)),
            glBufferData: sym!(
                "glBufferData",
                unsafe extern "C" fn(GLenum, GLsizeiptr, *const c_void, GLenum)
            ),
            glVertexAttribPointer: sym!(
                "glVertexAttribPointer",
                unsafe extern "C" fn(GLuint, GLint, GLenum, GLboolean, GLsizei, *const c_void)
            ),
            glEnableVertexAttribArray: sym!(
                "glEnableVertexAttribArray",
                unsafe extern "C" fn(GLuint)
            ),
            glGetAttribLocation: sym!(
                "glGetAttribLocation",
                unsafe extern "C" fn(GLuint, *const GLchar) -> GLint
            ),
            glGetUniformLocation: sym!(
                "glGetUniformLocation",
                unsafe extern "C" fn(GLuint, *const GLchar) -> GLint
            ),
            glUniform1i: sym!("glUniform1i", unsafe extern "C" fn(GLint, GLint)),
            glUniform1f: sym!("glUniform1f", unsafe extern "C" fn(GLint, GLfloat)),
            glUniform2f: sym!("glUniform2f", unsafe extern "C" fn(GLint, GLfloat, GLfloat)),
            glUniformMatrix3fv: sym!(
                "glUniformMatrix3fv",
                unsafe extern "C" fn(GLint, GLsizei, GLboolean, *const GLfloat)
            ),
            glGenTextures: sym!("glGenTextures", unsafe extern "C" fn(GLsizei, *mut GLuint)),
            glBindTexture: sym!("glBindTexture", unsafe extern "C" fn(GLenum, GLuint)),
            glTexParameteri: sym!(
                "glTexParameteri",
                unsafe extern "C" fn(GLenum, GLenum, GLint)
            ),
            glTexImage2D: sym!(
                "glTexImage2D",
                unsafe extern "C" fn(
                    GLenum,
                    GLint,
                    GLint,
                    GLsizei,
                    GLsizei,
                    GLint,
                    GLenum,
                    GLenum,
                    *const c_void,
                )
            ),
            glTexSubImage2D: sym!(
                "glTexSubImage2D",
                unsafe extern "C" fn(
                    GLenum,
                    GLint,
                    GLint,
                    GLint,
                    GLsizei,
                    GLsizei,
                    GLenum,
                    GLenum,
                    *const c_void,
                )
            ),
            glPixelStorei: sym!("glPixelStorei", unsafe extern "C" fn(GLenum, GLint)),
            glActiveTexture: sym!("glActiveTexture", unsafe extern "C" fn(GLenum)),
            glClear: sym!("glClear", unsafe extern "C" fn(GLbitfield)),
            glClearColor: sym!(
                "glClearColor",
                unsafe extern "C" fn(GLfloat, GLfloat, GLfloat, GLfloat)
            ),
            glViewport: sym!(
                "glViewport",
                unsafe extern "C" fn(GLint, GLint, GLsizei, GLsizei)
            ),
            glDrawArrays: sym!("glDrawArrays", unsafe extern "C" fn(GLenum, GLint, GLsizei)),
            glEnable: sym!("glEnable", unsafe extern "C" fn(GLenum)),
            glBlendFunc: sym!("glBlendFunc", unsafe extern "C" fn(GLenum, GLenum)),
            _library: library,
        })
    }
}

/// The process-wide GL entry-point table (loaded once, lazily).
fn gl() -> Result<&'static GlFns, String> {
    static GL: OnceLock<Result<GlFns, String>> = OnceLock::new();
    GL.get_or_init(GlFns::load).as_ref().map_err(|e| e.clone())
}

// ── Shaders + colorspace matrices ────────────────────────────────────────────

const VERTEX_SHADER: &str = r#"#version 150 core
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
    v_uv = a_uv;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
"#;

// I420 → RGB with the frame's signalled matrix (contract C1), plus a rounded-rect
// SDF mask and premultiplied-alpha output so the corners composite cleanly over
// the webview (spec §3.3).
const FRAGMENT_SHADER: &str = r#"#version 150 core
in vec2 v_uv;
out vec4 frag;
uniform sampler2D texY;
uniform sampler2D texU;
uniform sampler2D texV;
uniform mat3 yuv2rgb;
uniform vec2 uSize;
uniform vec2 uSourceSize;
uniform float uRadius;
void main() {
    vec2 sampleUv = v_uv;
    bool insideFrame = true;
    float tileAspect = uSize.x / max(uSize.y, 1.0);
    float sourceAspect = uSourceSize.x / max(uSourceSize.y, 1.0);
    if (tileAspect > sourceAspect) {
        float contentWidth = sourceAspect / tileAspect;
        float x0 = (1.0 - contentWidth) * 0.5;
        insideFrame = v_uv.x >= x0 && v_uv.x <= (x0 + contentWidth);
        sampleUv.x = (v_uv.x - x0) / contentWidth;
    } else {
        float contentHeight = tileAspect / sourceAspect;
        float y0 = (1.0 - contentHeight) * 0.5;
        insideFrame = v_uv.y >= y0 && v_uv.y <= (y0 + contentHeight);
        sampleUv.y = (v_uv.y - y0) / contentHeight;
    }
    vec3 rgb = vec3(0.0);
    if (insideFrame) {
        float y = texture(texY, sampleUv).r * 255.0;
        float u = texture(texU, sampleUv).r * 255.0;
        float v = texture(texV, sampleUv).r * 255.0;
        vec3 cde = vec3(y - 16.0, u - 128.0, v - 128.0);
        rgb = clamp(yuv2rgb * cde, 0.0, 1.0);
    }
    vec2 p = (v_uv - 0.5) * uSize;
    vec2 hs = uSize * 0.5;
    vec2 q = abs(p) - (hs - vec2(uRadius));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
    float alpha = clamp(0.5 - d, 0.0, 1.0);
    frag = vec4(rgb * alpha, alpha);
}
"#;

/// Column-major 3×3 YUV(limited-range)→RGB matrix operating on
/// `(Y-16, U-128, V-128)` and producing [0,1] RGB. The BT.709 coefficients match
/// the CPU `i420_to_rgba` converter byte-for-byte (contract C1); BT.601 uses the
/// SDTV set for frames that signalled it.
fn yuv_to_rgb_matrix(colorspace: ColorSpace) -> [f32; 9] {
    let scale = 1.0f32 / (256.0 * 255.0);
    // Rows are (R, G, B); stored column-major as m[col*3 + row].
    let (r, g, b): ([f32; 3], [f32; 3], [f32; 3]) = match colorspace {
        ColorSpace::Bt709 => (
            [298.0, 0.0, 459.0],
            [298.0, -55.0, -136.0],
            [298.0, 541.0, 0.0],
        ),
        ColorSpace::Bt601 => (
            [298.0, 0.0, 409.0],
            [298.0, -100.0, -208.0],
            [298.0, 516.0, 0.0],
        ),
    };
    [
        r[0] * scale,
        g[0] * scale,
        b[0] * scale, // column 0 (coefficient on Y-16)
        r[1] * scale,
        g[1] * scale,
        b[1] * scale, // column 1 (coefficient on U-128)
        r[2] * scale,
        g[2] * scale,
        b[2] * scale, // column 2 (coefficient on V-128)
    ]
}

// ── GL renderer (per surface, GL thread only) ────────────────────────────────

/// One track's GL renderer: an I420 texture triple + the shader program + a
/// full-quad VAO. Retains the last uploaded frame so expose/resize repaints work
/// without a new decode. GL objects are owned by the GLArea's context and freed
/// when it is destroyed, so there is deliberately no `glDelete*` on drop (the
/// context may already be gone).
struct GlRenderer {
    program: GLuint,
    vao: GLuint,
    tex_y: GLuint,
    tex_u: GLuint,
    tex_v: GLuint,
    tex_w: u32,
    tex_h: u32,
    has_frame: bool,
    colorspace: ColorSpace,
    u_tex_y: GLint,
    u_tex_u: GLint,
    u_tex_v: GLint,
    u_mat: GLint,
    u_size: GLint,
    u_source_size: GLint,
    u_radius: GLint,
}

impl GlRenderer {
    fn new(gl: &GlFns) -> Result<Self, String> {
        unsafe {
            let program = build_program(gl)?;

            // Full-quad (TRIANGLE_STRIP): pos.xy in NDC, uv.xy with v=0 at the
            // image top so texture row 0 maps to the top of the tile.
            #[rustfmt::skip]
            let verts: [f32; 16] = [
                -1.0, -1.0, 0.0, 1.0,
                 1.0, -1.0, 1.0, 1.0,
                -1.0,  1.0, 0.0, 0.0,
                 1.0,  1.0, 1.0, 0.0,
            ];
            let mut vao = 0;
            (gl.glGenVertexArrays)(1, &mut vao);
            (gl.glBindVertexArray)(vao);
            let mut vbo = 0;
            (gl.glGenBuffers)(1, &mut vbo);
            (gl.glBindBuffer)(GL_ARRAY_BUFFER, vbo);
            (gl.glBufferData)(
                GL_ARRAY_BUFFER,
                std::mem::size_of_val(&verts) as GLsizeiptr,
                verts.as_ptr() as *const c_void,
                GL_STATIC_DRAW,
            );
            let a_pos = (gl.glGetAttribLocation)(program, c"a_pos".as_ptr());
            let a_uv = (gl.glGetAttribLocation)(program, c"a_uv".as_ptr());
            if a_pos < 0 || a_uv < 0 {
                return Err("shader is missing a_pos / a_uv attributes".into());
            }
            let stride = (4 * std::mem::size_of::<f32>()) as GLsizei;
            (gl.glEnableVertexAttribArray)(a_pos as GLuint);
            (gl.glVertexAttribPointer)(
                a_pos as GLuint,
                2,
                GL_FLOAT,
                GL_FALSE,
                stride,
                std::ptr::null(),
            );
            (gl.glEnableVertexAttribArray)(a_uv as GLuint);
            (gl.glVertexAttribPointer)(
                a_uv as GLuint,
                2,
                GL_FLOAT,
                GL_FALSE,
                stride,
                (2 * std::mem::size_of::<f32>()) as *const c_void,
            );

            let mut textures = [0u32; 3];
            (gl.glGenTextures)(3, textures.as_mut_ptr());
            for &tex in &textures {
                (gl.glBindTexture)(GL_TEXTURE_2D, tex);
                (gl.glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                (gl.glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                (gl.glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                (gl.glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            }

            let u_tex_y = (gl.glGetUniformLocation)(program, c"texY".as_ptr());
            let u_tex_u = (gl.glGetUniformLocation)(program, c"texU".as_ptr());
            let u_tex_v = (gl.glGetUniformLocation)(program, c"texV".as_ptr());
            let u_mat = (gl.glGetUniformLocation)(program, c"yuv2rgb".as_ptr());
            let u_size = (gl.glGetUniformLocation)(program, c"uSize".as_ptr());
            let u_source_size = (gl.glGetUniformLocation)(program, c"uSourceSize".as_ptr());
            let u_radius = (gl.glGetUniformLocation)(program, c"uRadius".as_ptr());

            Ok(GlRenderer {
                program,
                vao,
                tex_y: textures[0],
                tex_u: textures[1],
                tex_v: textures[2],
                tex_w: 0,
                tex_h: 0,
                has_frame: false,
                colorspace: ColorSpace::default(),
                u_tex_y,
                u_tex_u,
                u_tex_v,
                u_mat,
                u_size,
                u_source_size,
                u_radius,
            })
        }
    }

    /// Upload a CPU I420 frame into the Y/U/V textures, (re)allocating on a
    /// dimension change.
    unsafe fn upload_i420(&mut self, gl: &GlFns, data: &[u8], width: u32, height: u32) {
        let expected = PixelFormat::I420.frame_size(width, height);
        if data.len() < expected || width == 0 || height == 0 {
            return;
        }
        let (w, h) = (width as usize, height as usize);
        let cw = w / 2;
        let ch = h / 2;
        let y_size = w * h;
        let uv_size = cw * ch;

        (gl.glPixelStorei)(GL_UNPACK_ALIGNMENT, 1);
        let realloc = width != self.tex_w || height != self.tex_h;
        if realloc {
            self.tex_w = width;
            self.tex_h = height;
        }

        let planes: [(GLuint, GLsizei, GLsizei, &[u8]); 3] = [
            (self.tex_y, w as GLsizei, h as GLsizei, &data[..y_size]),
            (
                self.tex_u,
                cw as GLsizei,
                ch as GLsizei,
                &data[y_size..y_size + uv_size],
            ),
            (
                self.tex_v,
                cw as GLsizei,
                ch as GLsizei,
                &data[y_size + uv_size..y_size + 2 * uv_size],
            ),
        ];
        for (index, (tex, pw, ph, plane)) in planes.into_iter().enumerate() {
            (gl.glActiveTexture)(GL_TEXTURE0 + index as GLenum);
            (gl.glBindTexture)(GL_TEXTURE_2D, tex);
            if realloc {
                (gl.glTexImage2D)(
                    GL_TEXTURE_2D,
                    0,
                    GL_R8,
                    pw,
                    ph,
                    0,
                    GL_RED,
                    GL_UNSIGNED_BYTE,
                    std::ptr::null(),
                );
            }
            (gl.glTexSubImage2D)(
                GL_TEXTURE_2D,
                0,
                0,
                0,
                pw,
                ph,
                GL_RED,
                GL_UNSIGNED_BYTE,
                plane.as_ptr() as *const c_void,
            );
        }
        self.has_frame = true;
    }

    /// Render one frame into the current GLArea framebuffer (physical px). A
    /// `Some(handle)` uploads first; `None` repaints the retained frame.
    fn render(
        &mut self,
        gl: &GlFns,
        phys_w: u32,
        phys_h: u32,
        radius: f32,
        handle: Option<DecodedFrameHandle>,
    ) -> Result<(), String> {
        unsafe {
            if let Some(handle) = handle {
                match handle {
                    DecodedFrameHandle::CpuI420 {
                        data,
                        width,
                        height,
                        colorspace,
                    } => {
                        self.colorspace = colorspace;
                        self.upload_i420(gl, &data, width, height);
                    }
                    other => {
                        // Tier-1 GPU-resident handle on the tier-2 path: honest
                        // loud error (spec §3.4/§3.7), never a silent drop/fake.
                        return Err(format!(
                            "GPU-resident handle {other:?} reached the tier-2 surface; \
                             tier-1 CUDA-GL / EGL-dmabuf interop is not engaged"
                        ));
                    }
                }
            }

            (gl.glViewport)(0, 0, phys_w as GLsizei, phys_h as GLsizei);
            (gl.glClearColor)(0.0, 0.0, 0.0, 0.0);
            (gl.glClear)(GL_COLOR_BUFFER_BIT);
            if !self.has_frame {
                return Ok(());
            }
            (gl.glEnable)(GL_BLEND);
            (gl.glBlendFunc)(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
            (gl.glUseProgram)(self.program);

            (gl.glActiveTexture)(GL_TEXTURE0);
            (gl.glBindTexture)(GL_TEXTURE_2D, self.tex_y);
            (gl.glUniform1i)(self.u_tex_y, 0);
            (gl.glActiveTexture)(GL_TEXTURE0 + 1);
            (gl.glBindTexture)(GL_TEXTURE_2D, self.tex_u);
            (gl.glUniform1i)(self.u_tex_u, 1);
            (gl.glActiveTexture)(GL_TEXTURE0 + 2);
            (gl.glBindTexture)(GL_TEXTURE_2D, self.tex_v);
            (gl.glUniform1i)(self.u_tex_v, 2);

            let matrix = yuv_to_rgb_matrix(self.colorspace);
            (gl.glUniformMatrix3fv)(self.u_mat, 1, GL_FALSE, matrix.as_ptr());
            (gl.glUniform2f)(self.u_size, phys_w as f32, phys_h as f32);
            (gl.glUniform2f)(self.u_source_size, self.tex_w as f32, self.tex_h as f32);
            (gl.glUniform1f)(self.u_radius, radius);

            (gl.glBindVertexArray)(self.vao);
            (gl.glDrawArrays)(GL_TRIANGLE_STRIP, 0, 4);
        }
        Ok(())
    }
}

/// Compile + link the I420→RGB program, returning a loud error with the GL info
/// log on failure.
unsafe fn build_program(gl: &GlFns) -> Result<GLuint, String> {
    let vs = compile_shader(gl, GL_VERTEX_SHADER, VERTEX_SHADER)?;
    let fs = compile_shader(gl, GL_FRAGMENT_SHADER, FRAGMENT_SHADER)?;
    let program = (gl.glCreateProgram)();
    (gl.glAttachShader)(program, vs);
    (gl.glAttachShader)(program, fs);
    (gl.glLinkProgram)(program);
    let mut status = 0;
    (gl.glGetProgramiv)(program, GL_LINK_STATUS, &mut status);
    if status == 0 {
        return Err(format!(
            "program link failed: {}",
            program_info_log(gl, program)
        ));
    }
    Ok(program)
}

unsafe fn compile_shader(gl: &GlFns, kind: GLenum, source: &str) -> Result<GLuint, String> {
    let shader = (gl.glCreateShader)(kind);
    let ptr = source.as_ptr() as *const GLchar;
    let len = source.len() as GLint;
    (gl.glShaderSource)(shader, 1, &ptr, &len);
    (gl.glCompileShader)(shader);
    let mut status = 0;
    (gl.glGetShaderiv)(shader, GL_COMPILE_STATUS, &mut status);
    if status == 0 {
        let mut log = vec![0u8; 1024];
        let mut written = 0;
        (gl.glGetShaderInfoLog)(
            shader,
            log.len() as GLsizei,
            &mut written,
            log.as_mut_ptr() as *mut GLchar,
        );
        log.truncate(written.max(0) as usize);
        return Err(format!(
            "shader compile failed: {}",
            String::from_utf8_lossy(&log)
        ));
    }
    Ok(shader)
}

unsafe fn program_info_log(gl: &GlFns, program: GLuint) -> String {
    let mut log = vec![0u8; 1024];
    let mut written = 0;
    (gl.glGetProgramInfoLog)(
        program,
        log.len() as GLsizei,
        &mut written,
        log.as_mut_ptr() as *mut GLchar,
    );
    log.truncate(written.max(0) as usize);
    String::from_utf8_lossy(&log).into_owned()
}

// ── Main-thread surface registry (thread-local) ──────────────────────────────

/// A track's GLArea, owned by the GTK main thread. The keep-latest frame slot
/// and the GL renderer are owned by the GLArea's render/unrealize closures (and
/// the `Send` handle's slot clone), so only the widget and the shared geometry
/// need to be reachable here for geometry/visibility/wake operations.
struct MainSurface {
    glarea: gtk::GLArea,
    geometry: Rc<RefCell<SurfaceGeometry>>,
}

/// Main-thread widgets that make up the native-video underlay stack.
struct RenderHost {
    fixed: gtk::Fixed,
    overlay: gtk::Overlay,
    webview: gtk::Widget,
    last_configure_pulse: RefCell<Option<Instant>>,
}

thread_local! {
    /// The overlay host the webview was reparented into; native GLAreas are
    /// positioned inside its `Fixed` underlay. Set once by [`install_render_host`].
    static RENDER_HOST: RefCell<Option<RenderHost>> = const { RefCell::new(None) };
    /// Live surfaces by id (GL thread only).
    static SURFACES: RefCell<HashMap<u64, MainSurface>> = RefCell::new(HashMap::new());
}

/// Reparent the main webview into a `gtk::Overlay` and install the `Fixed` host
/// that native GLAreas render inside (spec §3.3). Runs on the GTK main thread
/// (the Tauri `setup` hook).
pub fn install_render_host(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let already = RENDER_HOST.with(|h| h.borrow().is_some());
    if already {
        return Ok(());
    }

    let window = app
        .get_webview_window("main")
        .ok_or("main webview window not found")?;
    let vbox = window
        .default_vbox()
        .map_err(|e| format!("default_vbox: {e}"))?;

    // The WebKitWebView is packed as the child of the default vbox; move it into
    // a `gtk::Overlay` as the TOP (overlay) child, above a `Fixed` main child
    // that hosts the GLAreas. Video renders BELOW the webview; the webview's
    // background is cleared so the DOM's transparent stream tiles become real
    // holes down to the GL surface, while all other DOM chrome stays opaque and
    // composites over the video. Input needs no routing tricks: the webview is
    // the topmost interactive widget.
    let webview = vbox
        .children()
        .into_iter()
        .next()
        .ok_or("default vbox has no child to reparent")?;
    let overlay = gtk::Overlay::new();
    overlay.set_hexpand(true);
    overlay.set_vexpand(true);
    vbox.remove(&webview);
    let fixed = gtk::Fixed::new();
    fixed.set_halign(gtk::Align::Fill);
    fixed.set_valign(gtk::Align::Fill);
    fixed.set_hexpand(true);
    fixed.set_vexpand(true);
    overlay.add(&fixed);
    webview.set_halign(gtk::Align::Fill);
    webview.set_valign(gtk::Align::Fill);
    webview.set_hexpand(true);
    webview.set_vexpand(true);
    overlay.add_overlay(&webview);
    vbox.pack_start(&overlay, true, true, 0);
    overlay.show_all();

    // Clear the webview's own base background. Without this WebKit paints an
    // opaque backing color under the page and the GL underlay can never show
    // through, no matter what the DOM does. The underlay is unusable without
    // it, so a non-WebKit child is a hard install error (spec §3.7).
    let Some(wk_view) = webview.downcast_ref::<webkit2gtk::WebView>() else {
        return Err(
            "reparented vbox child is not a WebKitWebView; cannot install the underlay host".into(),
        );
    };
    webkit2gtk::WebViewExt::set_background_color(wk_view, &gtk::gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));

    // Paint the toplevel window in the app's dark base color (--bg-primary):
    // pixels the DOM leaves transparent that have no GLArea beneath them (the
    // shell gutters while a stream is live, a hidden surface's backdrop) land
    // here and must read as the app's own background, not GTK theme gray.
    if let Some(toplevel) = vbox.toplevel() {
        let provider = gtk::CssProvider::new();
        if provider
            .load_from_data(b"window { background-color: #141b17; }")
            .is_ok()
        {
            toplevel
                .style_context()
                .add_provider(&provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        }
    }

    RENDER_HOST.with(|h| {
        *h.borrow_mut() = Some(RenderHost {
            fixed,
            overlay,
            webview,
            last_configure_pulse: RefCell::new(None),
        })
    });
    tracing::info!(
        "native surface backend installed: GTK GLArea UNDERLAY (webview \
         transparent above), tier-2 (CPU I420 → glTexSubImage2D). Tier-1 GPU \
         interop (CUDA-GL / EGL-dmabuf) is NOT engaged this pass — it cannot \
         be made sound without a live GL/CUDA session; decoders run in \
         CPU-output mode (spec §3.4)."
    );
    Ok(())
}

/// Ask every widget in the underlay stack to redraw/reallocate. User reports
/// showed the first native frame was presented before the stream appeared, and
/// any manual app resize made it pop in immediately. A resize invalidates more
/// than the GLArea: it also repaints WebKit's transparent backing layer and the
/// overlay/toplevel that composites the underlay. Call this ONLY on geometry /
/// visibility transitions — never from the per-frame `present()` path. Continuous
/// webview invalidation while overlays are open made floating UI appear glued
/// into the stream (jank + "stuck" dismiss targets).
fn queue_underlay_repaint() {
    RENDER_HOST.with(|host| {
        let host = host.borrow();
        let Some(host) = host.as_ref() else {
            return;
        };

        host.fixed.queue_resize();
        host.fixed.queue_draw();
        host.overlay.queue_resize();
        host.overlay.queue_draw();
        host.webview.queue_resize();
        host.webview.queue_draw();
        if let Some(window) = host.webview.window() {
            window.invalidate_rect(None, true);
        }
        if let Some(window) = host.overlay.window() {
            window.invalidate_rect(None, true);
        }
        if let Some(toplevel) = host.overlay.toplevel() {
            toplevel.queue_draw();
            if let Some(window) = toplevel.window() {
                window.invalidate_rect(None, true);
            }
        }
    });
}

/// Force the same compositor configure path that a tiny manual window resize
/// triggers. GTK/WebKit can otherwise keep the transparent webview backing
/// layer stale even after both `queue_draw` and `invalidate_rect`, leaving a
/// correctly-rendering GLArea invisible until the user resizes the app. This is
/// deliberately throttled and called only from geometry/overlay transitions.
fn pulse_toplevel_configure() {
    RENDER_HOST.with(|host| {
        let host = host.borrow();
        let Some(host) = host.as_ref() else {
            return;
        };

        let now = Instant::now();
        {
            let mut last = host.last_configure_pulse.borrow_mut();
            if last
                .map(|instant| now.duration_since(instant) < Duration::from_millis(250))
                .unwrap_or(false)
            {
                return;
            }
            *last = Some(now);
        }

        let Some(toplevel_widget) = host.overlay.toplevel() else {
            return;
        };
        let Ok(window) = toplevel_widget.downcast::<gtk::Window>() else {
            return;
        };
        let width = window.allocated_width().max(1);
        let height = window.allocated_height().max(1);
        let pulse_width = width.saturating_add(1);
        window.resize(pulse_width, height);
        glib::timeout_add_local_once(Duration::from_millis(16), move || {
            window.resize(width, height);
            window.queue_draw();
        });
    });
}

/// Build one GLArea on the GTK main thread and register it (spec §3.3).
///
/// `error_slot` is the shared failure channel back to [`LinuxVideoSurface::present`]
/// (spec §3.7): the render callback records a fatal GL-thread error (context/GL
/// symbol load, shader compile/link, or a per-frame render error) into it, and
/// `present()` reports it upward so the decode worker tears the subscription down
/// with `media_native_render_failed` instead of silently blanking.
fn create_surface_on_main(
    id: u64,
    slot: Arc<Mutex<Option<DecodedFrameHandle>>>,
    error_slot: Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    RENDER_HOST.with(|host| {
        let host = host.borrow();
        let host = host
            .as_ref()
            .ok_or("native render host not installed (webview not reparented)")?;

        let glarea = gtk::GLArea::new();
        glarea.set_has_alpha(true);
        // Pin a desktop-GL (non-ES) context: both shaders are `#version 150 core`
        // (desktop GL only). On an EGL/GLES-only display GDK would otherwise hand
        // back a GLES context, failing shader compilation and rendering nothing.
        glarea.set_use_es(false);
        glarea.set_required_version(3, 2);
        glarea.set_size_request(1, 1);
        glarea.set_visible(false); // created hidden at a zero rect (spec §3.1)

        let geometry = Rc::new(RefCell::new(SurfaceGeometry {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            dpr: 1.0,
            corner_radius: 0.0,
            visible: false,
        }));
        let renderer: Rc<RefCell<Option<GlRenderer>>> = Rc::new(RefCell::new(None));

        let slot_cb = slot.clone();
        let geometry_cb = geometry.clone();
        let renderer_cb = renderer.clone();
        let error_cb = error_slot.clone();
        glarea.connect_render(move |area, _ctx| {
            render_callback(area, &slot_cb, &geometry_cb, &renderer_cb, &error_cb);
            glib::Propagation::Stop
        });
        // The GL objects die with the context; drop the renderer handle when the
        // area is unrealized so a re-realize rebuilds it against a fresh context.
        let renderer_unrealize = renderer.clone();
        glarea.connect_unrealize(move |_area| {
            renderer_unrealize.borrow_mut().take();
        });
        // Defense in depth: the GLArea sits BELOW the webview in the underlay,
        // but give its native GdkWindow an empty input region anyway so no
        // stacking quirk can ever let it swallow pointer events meant for the
        // DOM (the 2026-07-07 unclickable-controls bug).
        glarea.connect_realize(|area| {
            if let Some(window) = area.window() {
                window.input_shape_combine_region(&gtk::cairo::Region::create(), 0, 0);
            }
        });

        host.fixed.put(&glarea, 0, 0);
        // `slot`/`renderer` outlive this scope through the render + unrealize
        // closures captured above; only the widget and geometry are stored.
        SURFACES.with(|surfaces| {
            surfaces
                .borrow_mut()
                .insert(id, MainSurface { glarea, geometry });
        });
        Ok(())
    })
}

/// The GLArea render signal handler (GL thread, context current).
fn render_callback(
    area: &gtk::GLArea,
    slot: &Arc<Mutex<Option<DecodedFrameHandle>>>,
    geometry: &Rc<RefCell<SurfaceGeometry>>,
    renderer: &Rc<RefCell<Option<GlRenderer>>>,
    error_slot: &Arc<Mutex<Option<String>>>,
) {
    // Record a fatal GL-thread failure (first one wins) so `present()` can route
    // it to the §3.7 teardown path instead of the surface silently going blank.
    let fail = |reason: String| {
        tracing::error!("{reason}");
        let mut slot = error_slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(reason);
        }
    };

    let gl = match gl() {
        Ok(gl) => gl,
        Err(err) => {
            fail(format!("native surface GL unavailable: {err}"));
            return;
        }
    };
    {
        let mut slot_renderer = renderer.borrow_mut();
        if slot_renderer.is_none() {
            match GlRenderer::new(gl) {
                Ok(renderer) => *slot_renderer = Some(renderer),
                Err(err) => {
                    fail(format!("native surface renderer init failed: {err}"));
                    return;
                }
            }
        }
    }

    let scale = area.scale_factor().max(1);
    let phys_w = (area.allocated_width().max(1) * scale) as u32;
    let phys_h = (area.allocated_height().max(1) * scale) as u32;
    let radius = geometry.borrow().physical_corner_radius();
    let handle = slot.lock().unwrap_or_else(|e| e.into_inner()).take();

    let mut slot_renderer = renderer.borrow_mut();
    if let Some(renderer) = slot_renderer.as_mut() {
        if let Err(err) = renderer.render(gl, phys_w, phys_h, radius, handle) {
            fail(format!("native surface render failed: {err}"));
        }
    }
}

/// Apply geometry / visibility to a surface on the GTK main thread.
fn update_geometry_on_main(id: u64, geometry: SurfaceGeometry) {
    SURFACES.with(|surfaces| {
        let surfaces = surfaces.borrow();
        let Some(surface) = surfaces.get(&id) else {
            return;
        };
        let was_visible = surface.geometry.borrow().visible;
        *surface.geometry.borrow_mut() = geometry;
        let (x, y, w, h) = geometry.logical_rect();
        RENDER_HOST.with(|host| {
            if let Some(host) = host.borrow().as_ref() {
                host.fixed.move_(&surface.glarea, x, y);
            }
        });
        surface.glarea.set_size_request(w, h);
        if geometry.visible {
            surface.glarea.show();
        } else {
            surface.glarea.hide();
        }
        surface.glarea.set_visible(geometry.visible);
        if geometry.visible && !was_visible {
            eprintln!(
                "[native-diag] native-render geometry visible surface_id={id} logical={x},{y} {w}x{h} physical={}x{} dpr={:.3}",
                geometry.width, geometry.height, geometry.dpr
            );
        }
        // Only invalidate the full underlay stack / pulse the toplevel when
        // visibility flips. Per-tick geometry updates (scroll) and every
        // present() already queue_render on the GLArea; re-rasterizing the
        // webview on those paths glued DOM overlays into the stream.
        let visibility_flipped = geometry.visible != was_visible;
        if geometry.visible {
            surface.glarea.queue_resize();
            surface.glarea.queue_render();
        }
        if visibility_flipped {
            queue_underlay_repaint();
            if geometry.visible {
                pulse_toplevel_configure();
            }
        }
    });
}

/// Remove and destroy a surface's GLArea on the GTK main thread.
fn destroy_surface_on_main(id: u64) {
    SURFACES.with(|surfaces| {
        if let Some(surface) = surfaces.borrow_mut().remove(&id) {
            RENDER_HOST.with(|host| {
                if let Some(host) = host.borrow().as_ref() {
                    host.fixed.remove(&surface.glarea);
                }
            });
            // Dropping `surface` (and its GLArea) here on the main thread lets
            // GTK destroy the widget and its GL context.
        }
    });
}

// ── Send handle ──────────────────────────────────────────────────────────────

/// The `Send` surface handle held by the registry and the dispatch layer. Holds
/// no GTK object; every operation marshals to the GTK main thread.
pub struct LinuxVideoSurface {
    id: SurfaceId,
    app: tauri::AppHandle,
    /// Keep-latest frame slot shared with the render callback.
    slot: Arc<Mutex<Option<DecodedFrameHandle>>>,
    /// Coalesces `queue_render` wakes to at most one in-flight main-thread hop.
    wake_pending: Arc<AtomicBool>,
    /// Fatal GL-thread error reported by the render callback (spec §3.7). Sticky
    /// once set; `present()` surfaces it so the decode worker's present-error
    /// streak trips `fail_native_surface` (emit `media_native_render_failed` +
    /// tear down) rather than the surface staying permanently blank.
    error_slot: Arc<Mutex<Option<String>>>,
}

impl VideoSurface for LinuxVideoSurface {
    fn new(app: &tauri::AppHandle, surface_id: SurfaceId) -> Result<Self, String> {
        let slot: Arc<Mutex<Option<DecodedFrameHandle>>> = Arc::new(Mutex::new(None));
        let slot_main = slot.clone();
        let error_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let error_slot_main = error_slot.clone();
        let id = surface_id.0;

        // Create the GLArea on the GTK main thread and block for the result (this
        // runs inside `spawn_blocking`, so blocking is fine).
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(create_surface_on_main(id, slot_main, error_slot_main));
        })
        .map_err(|e| format!("run_on_main_thread (surface create) failed: {e}"))?;
        rx.recv()
            .map_err(|e| format!("surface create channel closed: {e}"))??;

        Ok(LinuxVideoSurface {
            id: surface_id,
            app: app.clone(),
            slot,
            wake_pending: Arc::new(AtomicBool::new(false)),
            error_slot,
        })
    }

    fn update_geometry(&mut self, geometry: SurfaceGeometry) -> Result<(), String> {
        // Fire-and-forget: geometry reports arrive at the display cadence, so we
        // never block the async worker waiting for the main thread.
        let id = self.id.0;
        self.app
            .run_on_main_thread(move || update_geometry_on_main(id, geometry))
            .map_err(|e| format!("run_on_main_thread (geometry) failed: {e}"))
    }

    fn present(&mut self, frame: DecodedFrameHandle) -> Result<(), String> {
        // A fatal GL-thread failure (context/GL-symbol load, shader compile/link,
        // or a render error) reported by the render callback is surfaced here so
        // the decode worker's present-error streak trips the §3.7 teardown
        // (media_native_render_failed) instead of the surface blanking forever.
        if let Some(err) = self
            .error_slot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return Err(err);
        }

        // Tier-2 working path: only CPU I420 handles are uploadable here. A
        // GPU-resident handle means tier-1 interop would be required but is not
        // engaged (see the module tier note) — a loud error, never a silent drop
        // (spec §3.4/§3.7). In tier-2 the decoder produces only CpuI420, so this
        // is unreachable in normal operation and exists to keep the contract honest.
        if !matches!(frame, DecodedFrameHandle::CpuI420 { .. }) {
            return Err(format!(
                "tier-2 native surface received a GPU-resident handle ({frame:?}); \
                 tier-1 CUDA-GL / EGL-dmabuf interop is not engaged"
            ));
        }

        // Keep-latest: replace the pending frame and wake one render.
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(frame);
        if !self.wake_pending.swap(true, Ordering::SeqCst) {
            let id = self.id.0;
            let wake = self.wake_pending.clone();
            let _ = self.app.run_on_main_thread(move || {
                wake.store(false, Ordering::SeqCst);
                SURFACES.with(|surfaces| {
                    if let Some(surface) = surfaces.borrow().get(&id) {
                        // Only the GLArea — never queue_underlay_repaint here.
                        // Per-frame webview invalidation is what made overlays
                        // appear stuck inside the live stream.
                        surface.glarea.queue_render();
                    }
                });
            });
        }
        Ok(())
    }

    fn destroy(self) {
        // The real teardown runs in `Drop` (below) so the boxed-trait-object case
        // the registry holds is torn down the same way.
    }
}

impl Drop for LinuxVideoSurface {
    fn drop(&mut self) {
        let id = self.id.0;
        let _ = self
            .app
            .run_on_main_thread(move || destroy_surface_on_main(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bt709_matrix_matches_cpu_converter_reference() {
        // The BT.709 matrix must reproduce the CPU converter's grey mapping:
        // Y=126 (mid), U=V=128 → R=G=B=(298*110)/(256*255) ≈ 0.502.
        let m = yuv_to_rgb_matrix(ColorSpace::Bt709);
        let (c, d, e) = (126.0f32 - 16.0, 0.0f32, 0.0f32);
        let r = m[0] * c + m[3] * d + m[6] * e;
        let g = m[1] * c + m[4] * d + m[7] * e;
        let b = m[2] * c + m[5] * d + m[8] * e;
        let expected = (298.0 * 110.0) / (256.0 * 255.0);
        for channel in [r, g, b] {
            assert!((channel - expected).abs() < 1e-4, "grey maps equally");
        }
    }

    #[test]
    fn bt601_and_bt709_differ_on_chroma() {
        // Pure red chroma (V high) diverges between the two matrices' R row.
        let m709 = yuv_to_rgb_matrix(ColorSpace::Bt709);
        let m601 = yuv_to_rgb_matrix(ColorSpace::Bt601);
        assert_ne!(m709[6], m601[6], "V→R coefficient differs by matrix");
    }
}
