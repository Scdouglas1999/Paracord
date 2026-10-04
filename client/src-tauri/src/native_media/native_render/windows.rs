//! Windows native-surface backend: a DirectComposition visual tree composed
//! **under** the transparent WebView2, one Direct3D 11 swapchain per video
//! surface (the same underlay contract as [`linux`](super) and `macos`).
//!
//! # The window stack wry builds, and where the video goes
//! ```text
//! tao top-level HWND (the Tauri window)
//! └── "WRY_WEBVIEW" container HWND   (WS_CHILD, no background brush, fills the
//!     │                               client area; the controller's ParentWindow)
//!     └── WebView2 HWND(s)            (owned by msedgewebview2.exe, drawn by
//!                                      Chromium with per-pixel alpha)
//! ```
//! `IDCompositionDevice::CreateTargetForHwnd` documents four layers per window:
//! (1) what is drawn into the window's own DC, (2) a non-topmost DirectComposition
//! tree, (3) the window's child windows, (4) a topmost tree. The tree is bound to
//! the **container** (the WebView2 controller's `ParentWindow`) with
//! `topmost = FALSE`, so it is layer 2 there: above the container's own (never
//! painted) DC content and below its only children, the WebView2 windows. The
//! webview's default background is cleared to alpha 0, so wherever the page
//! leaves a pixel transparent (the hole over a stream tile, the gutters) the
//! tree shows through.
//!
//! Binding the top-level window instead would put the tree in the top-level's
//! layer 2, *behind the container child*, which covers the whole client area
//! and, as a separate child window, clips (occludes) the tree. Binding the
//! container leaves exactly one thing above the tree: the page.
//!
//! The tree: a root visual holding a **ground** visual (the app's `--bg-base`,
//! see [`set_ground_color`]) at the bottom, and one visual per *shown* surface
//! above it.
//!
//! # Coordinate space (DPI)
//! A DirectComposition tree bound to an HWND is positioned in that window's
//! **client-area pixels, origin at the client top-left**; DirectComposition
//! applies no DPI scaling of its own. The Tauri process is per-monitor-v2 DPI
//! aware (tao), so client coordinates, the controller's `Bounds`, and the
//! swapchain sizes are all physical pixels. The page reports each surface in
//! physical pixels relative to the WebView2's viewport (CSS px times
//! `devicePixelRatio`, which on WebView2 is the rasterization scale times the
//! zoom, so it is the device pixel the page actually renders). The viewport's
//! top-left is the controller's `Bounds` origin inside the container (wry keeps
//! it at 0,0 for the main window; it is read at install and added anyway), so a
//! surface's visual offset is `bounds.origin + (geometry.x, geometry.y)`, and
//! its swapchain is `geometry.width x geometry.height` pixels, unscaled.
//!
//! # Threading
//! Every D3D11 / DXGI / DirectComposition object lives on ONE dedicated render
//! thread ("native-render-d3d", started by [`install_render_host`], in the
//! multithreaded COM apartment). Everything else talks to it over a channel
//! ([`Command`]): create (blocking for its result; `new()` runs inside
//! `spawn_blocking`), geometry, present wake, destroy, ground color, client
//! size. The `Send` [`WindowsVideoSurface`] holds no COM object: a keep-latest
//! frame slot, a coalescing wake flag (at most one wake in flight per surface,
//! like the Linux `queue_render` hop) and a sticky error slot. The render thread
//! batches whatever commands are queued, commits the DirectComposition device
//! once per batch, and only then confirms reveals.
//!
//! # Drawing
//! Each frame ([`DecodedFrameHandle::CpuI420`], the only kind the Windows decode
//! path produces) is uploaded into three `R8_UNORM` textures with
//! `UpdateSubresource` and drawn with one full-target triangle through a pixel
//! shader that is the HLSL twin of the Linux `FRAGMENT_SHADER`: the frame's
//! limited-range BT.709 / BT.601 matrix, `SurfaceFit::uv_window` placement
//! (mirrored for the self-view), and a rounded-rect SDF mask with premultiplied
//! output into a `B8G8R8A8_UNORM`, `DXGI_ALPHA_MODE_PREMULTIPLIED`,
//! flip-sequential, two-buffer composition swapchain. Shaders are compiled once
//! at install with `D3DCompile` (`d3dcompiler_47.dll`, in-box since Windows
//! 8.1). `Present(0, 0)`: one thread serves every surface, so it never waits on
//! a vblank per surface; a newer frame simply replaces a queued one.
//!
//! # Failure law (spec §3.7)
//! Any install failure is an `Err` naming the step (it becomes
//! `renderer_status`, so every video subscription fails loudly with it), and the
//! webview is only made transparent after the tree exists. A render-thread error
//! for a surface goes into its sticky error slot, which `present()` returns, so
//! the decode worker's present-error streak tears the subscription down.
//!
//! # Verification status
//! Compile-checked for `x86_64-pc-windows-gnu` from Linux. **Never run**: the
//! layering claim above (a non-topmost tree on the container shows through the
//! transparent WebView2 child window) follows the documented layer model but has
//! not been observed on a real machine.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};

use paracord_codec::video::{ColorSpace, DecodedFrameHandle, PixelFormat};
use tauri::Manager;
use windows::core::{Interface, PCSTR};
use windows::Win32::Foundation::{HMODULE, HWND, RECT, RPC_E_CHANGED_MODE};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{
    ID3DBlob, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST, D3D_DRIVER_TYPE_HARDWARE,
    D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Buffer, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader,
    ID3D11RasterizerState, ID3D11RenderTargetView, ID3D11SamplerState, ID3D11ShaderResourceView,
    ID3D11Texture2D, ID3D11VertexShader, D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_SHADER_RESOURCE,
    D3D11_BUFFER_DESC, D3D11_COMPARISON_NEVER, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CULL_NONE,
    D3D11_FILL_SOLID, D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_FLOAT32_MAX, D3D11_RASTERIZER_DESC,
    D3D11_SAMPLER_DESC, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_TEXTURE_ADDRESS_CLAMP,
    D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionScaleTransform,
    IDCompositionTarget, IDCompositionVisual,
    DCOMPOSITION_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR, DCOMPOSITION_BORDER_MODE_HARD,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8_UNORM,
    DXGI_FORMAT_UNKNOWN, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, DXGI_PRESENT, DXGI_SCALING_STRETCH,
    DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
    DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use super::{ShownNotifier, SurfaceFit, SurfaceGeometry, SurfaceId, VideoSurface};

/// The largest swapchain / texture edge Direct3D 11 guarantees (feature level
/// 11; 10.x guarantees 8192, which `CreateSwapChainForComposition` will refuse
/// loudly on such hardware).
const MAX_EXTENT: u32 = 16384;

// ── Shaders + colorspace matrices ────────────────────────────────────

/// A full-target triangle from `SV_VertexID` (no vertex buffer or input
/// layout). `uv` is (0,0) at the top-left of the target, as the Linux quad's
/// `v_uv`, so texture row 0 lands at the top of the tile.
const VERTEX_SHADER: &str = r#"
struct VsOut {
    float4 pos : SV_Position;
    float2 uv : TEXCOORD0;
};
VsOut vs_main(uint id : SV_VertexID) {
    VsOut o;
    float2 uv = float2((id << 1) & 2, id & 2);
    o.uv = uv;
    o.pos = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
    return o;
}
"#;

/// The HLSL twin of the Linux `FRAGMENT_SHADER`: I420 to RGB with the frame's
/// limited-range matrix (rows `rowR/G/B` applied to `(Y-16, U-128, V-128)`),
/// `SurfaceFit::uv_window` placement, and a rounded-rect SDF mask with
/// premultiplied-alpha output. `SampleLevel` keeps the samples legal inside
/// the branch (there are no mips, so it is the same sample).
const PIXEL_SHADER: &str = r#"
Texture2D texY : register(t0);
Texture2D texU : register(t1);
Texture2D texV : register(t2);
SamplerState samp : register(s0);
cbuffer Params : register(b0) {
    float4 rowR;
    float4 rowG;
    float4 rowB;
    float2 uSize;
    float2 uUvScale;
    float2 uUvCenter;
    float uRadius;
    float uPad;
};
struct VsOut {
    float4 pos : SV_Position;
    float2 uv : TEXCOORD0;
};
float4 ps_main(VsOut i) : SV_Target {
    float2 sampleUv = (i.uv - 0.5) * uUvScale + uUvCenter;
    bool insideFrame = all(sampleUv >= 0.0) && all(sampleUv <= 1.0);
    float3 rgb = float3(0.0, 0.0, 0.0);
    if (insideFrame) {
        float y = texY.SampleLevel(samp, sampleUv, 0).r * 255.0;
        float u = texU.SampleLevel(samp, sampleUv, 0).r * 255.0;
        float v = texV.SampleLevel(samp, sampleUv, 0).r * 255.0;
        float3 cde = float3(y - 16.0, u - 128.0, v - 128.0);
        rgb = saturate(float3(dot(rowR.xyz, cde), dot(rowG.xyz, cde), dot(rowB.xyz, cde)));
    }
    float2 p = (i.uv - 0.5) * uSize;
    float2 hs = uSize * 0.5;
    float2 q = abs(p) - (hs - float2(uRadius, uRadius));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
    float alpha = saturate(0.5 - d);
    return float4(rgb * alpha, alpha);
}
"#;

/// Row-major 3x3 limited-range YUV to RGB matrix on `(Y-16, U-128, V-128)`,
/// producing [0,1] RGB: the same coefficients as the Linux shader's
/// `yuv_to_rgb_matrix` (BT.709 matches the CPU `i420_to_rgba` converter,
/// contract C1). Rows are (R, G, B).
fn yuv_to_rgb_rows(colorspace: ColorSpace) -> [[f32; 3]; 3] {
    let scale = 1.0f32 / (256.0 * 255.0);
    let rows: [[f32; 3]; 3] = match colorspace {
        ColorSpace::Bt709 => [
            [298.0, 0.0, 459.0],
            [298.0, -55.0, -136.0],
            [298.0, 541.0, 0.0],
        ],
        ColorSpace::Bt601 => [
            [298.0, 0.0, 409.0],
            [298.0, -100.0, -208.0],
            [298.0, 516.0, 0.0],
        ],
    };
    rows.map(|row| row.map(|c| c * scale))
}

/// The pixel shader's `Params` constant buffer, laid out as HLSL packs it
/// (each `float4`/pair of `float2`s one 16-byte register).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
struct ShaderConstants {
    row_r: [f32; 4],
    row_g: [f32; 4],
    row_b: [f32; 4],
    size: [f32; 2],
    uv_scale: [f32; 2],
    uv_center: [f32; 2],
    radius: f32,
    pad: f32,
}

/// Everything the pixel shader needs for one draw.
fn shader_constants(
    colorspace: ColorSpace,
    fit: SurfaceFit,
    geometry: &SurfaceGeometry,
    target: (u32, u32),
    frame: (u32, u32),
) -> ShaderConstants {
    let rows = yuv_to_rgb_rows(colorspace);
    let mut window = fit.uv_window(
        target.0 as f32,
        target.1 as f32,
        frame.0 as f32,
        frame.1 as f32,
    );
    if geometry.mirrored {
        window = window.mirrored();
    }
    let row = |r: [f32; 3]| [r[0], r[1], r[2], 0.0];
    ShaderConstants {
        row_r: row(rows[0]),
        row_g: row(rows[1]),
        row_b: row(rows[2]),
        size: [target.0 as f32, target.1 as f32],
        uv_scale: window.scale,
        uv_center: window.center,
        radius: geometry.physical_corner_radius(),
        pad: 0.0,
    }
}

/// The swapchain size for a geometry: the physical rect, at least 1x1 and at
/// most what Direct3D 11 can allocate.
fn swapchain_extent(geometry: &SurfaceGeometry) -> (u32, u32) {
    (
        geometry.width.clamp(1, MAX_EXTENT),
        geometry.height.clamp(1, MAX_EXTENT),
    )
}

/// Where a surface's visual sits in the container's client area: the
/// webview's origin there (its controller `Bounds`) plus the page's physical
/// offset inside the webview.
fn visual_offset(webview_origin: (i32, i32), geometry: &SurfaceGeometry) -> (f32, f32) {
    (
        (webview_origin.0 + geometry.x) as f32,
        (webview_origin.1 + geometry.y) as f32,
    )
}

// ── Commands to the render thread ────────────────────────────────────

/// What a surface shares with the render thread.
struct SurfaceShared {
    /// Keep-latest frame slot written by `present()`.
    slot: Mutex<Option<DecodedFrameHandle>>,
    /// At most one present wake in flight.
    wake_pending: AtomicBool,
    /// First fatal render-thread error for this surface (sticky).
    error: Mutex<Option<String>>,
}

impl SurfaceShared {
    fn record_error(&self, reason: String) {
        tracing::error!("{reason}");
        let mut slot = self.error.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(reason);
        }
    }
}

enum Command {
    Create {
        id: u64,
        fit: SurfaceFit,
        shown: ShownNotifier,
        shared: Arc<SurfaceShared>,
        reply: Sender<Result<(), String>>,
    },
    Geometry {
        id: u64,
        geometry: SurfaceGeometry,
    },
    Present {
        id: u64,
    },
    Destroy {
        id: u64,
    },
    Ground {
        rgb: [u8; 3],
    },
    ClientSize {
        width: u32,
        height: u32,
    },
}

/// The render thread's command queue, set once the host is installed.
static RENDER_TX: OnceLock<Sender<Command>> = OnceLock::new();

/// The app's ground color (`--bg-base`) as `#rrggbb`, remembered even before
/// the host is installed (see the Linux backend's `GROUND_COLOR` for why the
/// shell repeats what the renderer says instead of holding a literal). `None`
/// until the renderer has spoken; until then the ground visual is not in the
/// tree and nothing is invented.
static GROUND_COLOR: Mutex<Option<String>> = Mutex::new(None);

fn render_tx() -> Result<&'static Sender<Command>, String> {
    RENDER_TX
        .get()
        .ok_or_else(|| "the Windows native render host is not installed".to_string())
}

// ── Host install (main thread) ───────────────────────────────────────

/// What the main thread reads from the WebView2 controller.
struct WebviewHost {
    /// The controller's parent window (wry's container), as an integer so it
    /// can cross to the render thread.
    container: isize,
    /// The controller's bounds origin in the container's client area.
    origin: (i32, i32),
}

/// Run `f` on the main webview's controller and return its result. Tauri runs
/// the closure inline when called on the main thread (the setup hook), which
/// this relies on; anything else is an error rather than a wait that could
/// deadlock the main thread.
fn with_controller<T: Send + 'static>(
    window: &tauri::WebviewWindow,
    what: &str,
    f: impl FnOnce(
            &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
        ) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let _ = tx.send(f(&webview.controller()));
        })
        .map_err(|err| format!("{what}: with_webview failed: {err}"))?;
    rx.try_recv().map_err(|_| {
        format!(
            "{what}: the WebView2 controller was not reachable synchronously (the host must be \
             installed on the main thread, from the setup hook)"
        )
    })?
}

/// Install the DirectComposition underlay under the main window's WebView2 and
/// make the webview transparent. Runs once on the main thread from the Tauri
/// `setup` hook (after `configure_webview2_overrides`).
pub fn install_render_host(app: &tauri::AppHandle) -> Result<(), String> {
    if RENDER_TX.get().is_some() {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("main webview window not found")?;

    // 1. Where the WebView2 lives: its parent window and its bounds there.
    let host = with_controller(&window, "reading the WebView2 host window", |controller| {
        let mut parent = HWND::default();
        let mut bounds = RECT::default();
        unsafe {
            controller
                .ParentWindow(&mut parent)
                .map_err(|err| format!("ICoreWebView2Controller::ParentWindow failed: {err}"))?;
            controller
                .Bounds(&mut bounds)
                .map_err(|err| format!("ICoreWebView2Controller::Bounds failed: {err}"))?;
        }
        if parent.is_invalid() {
            return Err("the WebView2 controller has no parent window".to_string());
        }
        Ok(WebviewHost {
            container: parent.0 as isize,
            origin: (bounds.left, bounds.top),
        })
    })?;
    let client = window
        .inner_size()
        .map_err(|err| format!("reading the window's client size failed: {err}"))?;

    // 2. The render thread builds the device, the target and the tree, and
    //    reports whether it could. Nothing visible has changed yet.
    let (command_tx, command_rx) = mpsc::channel();
    let (init_tx, init_rx) = mpsc::channel();
    let container = host.container;
    let origin = host.origin;
    let (width, height) = (client.width, client.height);
    std::thread::Builder::new()
        .name("native-render-d3d".to_string())
        .spawn(move || render_thread(container, origin, (width, height), command_rx, init_tx))
        .map_err(|err| format!("spawning the Direct3D render thread failed: {err}"))?;
    init_rx
        .recv()
        .map_err(|_| "the Direct3D render thread exited during setup".to_string())??;

    // 3. Only now clear the webview's background: a transparent page with no
    //    tree under it would be a hole through the whole window. WebView2
    //    accepts alpha 0 or 255 only; 0 makes every transparent page pixel
    //    show the tree.
    with_controller(&window, "clearing the WebView2 background", |controller| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
        };
        let controller2 = controller
            .cast::<ICoreWebView2Controller2>()
            .map_err(|err| {
                format!("this WebView2 runtime has no ICoreWebView2Controller2: {err}")
            })?;
        unsafe {
            controller2
                .SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                    A: 0,
                    R: 0,
                    G: 0,
                    B: 0,
                })
                .map_err(|err| format!("SetDefaultBackgroundColor(transparent) failed: {err}"))
        }
    })?;

    // 4. Keep the ground sized to the client area. wry sizes its container to
    //    the top-level client area on every WM_SIZE, so the top-level's
    //    `Resized` (physical px) is the container's size.
    let resize_tx = command_tx.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Resized(size) = event {
            if size.width > 0 && size.height > 0 {
                let _ = resize_tx.send(Command::ClientSize {
                    width: size.width,
                    height: size.height,
                });
            }
        }
    });

    let known = GROUND_COLOR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(color) = known {
        let _ = command_tx.send(Command::Ground {
            rgb: super::ground_rgb(&color),
        });
    }
    let _ = RENDER_TX.set(command_tx);
    tracing::info!(
        container = container,
        origin_x = origin.0,
        origin_y = origin.1,
        "native surface backend installed: DirectComposition underlay (non-topmost tree on the \
         WebView2 container, webview transparent above), Direct3D 11, CPU I420 upload"
    );
    Ok(())
}

/// The renderer's answer for `--bg-base`, already validated as `#rrggbb`
/// (`super::validated_ground_color`). Remembered even when no host is
/// installed yet, so the color is in hand when one is.
pub fn set_ground_color(app: &tauri::AppHandle, color: &str) -> Result<(), String> {
    let _ = app;
    {
        let mut slot = GROUND_COLOR.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_deref() == Some(color) {
            return Ok(());
        }
        *slot = Some(color.to_string());
    }
    match RENDER_TX.get() {
        Some(tx) => tx
            .send(Command::Ground {
                rgb: super::ground_rgb(color),
            })
            .map_err(|_| "the Direct3D render thread has stopped".to_string()),
        // Not installed (yet, or it failed): remembered for the install.
        None => Ok(()),
    }
}

// ── Render thread ────────────────────────────────────────────────────

/// The shared drawing state: compiled shaders and fixed pipeline state.
struct Pipeline {
    vertex_shader: ID3D11VertexShader,
    pixel_shader: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    rasterizer: ID3D11RasterizerState,
    constants: ID3D11Buffer,
}

/// The bottom visual: a 1x1 swapchain cleared to the ground color and scaled
/// (nearest neighbor, hard edges) to the client area, so a resize is a
/// transform change and never a reallocation.
struct Ground {
    visual: IDCompositionVisual,
    swapchain: IDXGISwapChain1,
    scale: IDCompositionScaleTransform,
    attached: bool,
}

/// One surface's Y/U/V textures.
struct Planes {
    textures: [ID3D11Texture2D; 3],
    views: [Option<ID3D11ShaderResourceView>; 3],
    width: u32,
    height: u32,
}

/// One video surface on the render thread.
struct Surface {
    visual: IDCompositionVisual,
    swapchain: IDXGISwapChain1,
    target_view: Option<ID3D11RenderTargetView>,
    extent: (u32, u32),
    planes: Option<Planes>,
    colorspace: ColorSpace,
    fit: SurfaceFit,
    geometry: SurfaceGeometry,
    attached: bool,
    shown: ShownNotifier,
    confirmed: u64,
    shared: Arc<SurfaceShared>,
}

struct Host {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    factory: IDXGIFactory2,
    dcomp: IDCompositionDevice,
    _target: IDCompositionTarget,
    root: IDCompositionVisual,
    ground: Ground,
    pipeline: Pipeline,
    webview_origin: (i32, i32),
    surfaces: HashMap<u64, Surface>,
}

fn hr(what: &str) -> impl Fn(windows::core::Error) -> String + '_ {
    move |err| format!("{what} failed: {err}")
}

fn render_thread(
    container: isize,
    webview_origin: (i32, i32),
    client: (u32, u32),
    commands: Receiver<Command>,
    init: Sender<Result<(), String>>,
) {
    let hr_init = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr_init.is_err() && hr_init != RPC_E_CHANGED_MODE {
        let _ = init.send(Err(format!(
            "CoInitializeEx on the render thread failed: {hr_init}"
        )));
        return;
    }
    let mut host = match Host::new(HWND(container as *mut _), webview_origin, client) {
        Ok(host) => host,
        Err(reason) => {
            let _ = init.send(Err(format!("native video underlay: {reason}")));
            return;
        }
    };
    if init.send(Ok(())).is_err() {
        return;
    }

    while let Ok(first) = commands.recv() {
        let mut batch = vec![first];
        while let Ok(more) = commands.try_recv() {
            batch.push(more);
        }
        let mut commit = false;
        let mut reveals: Vec<(ShownNotifier, u64)> = Vec::new();
        for command in batch {
            commit |= host.handle(command, &mut reveals);
        }
        if commit {
            if let Err(err) = unsafe { host.dcomp.Commit() } {
                let reason = format!("IDCompositionDevice::Commit failed: {err}");
                for surface in host.surfaces.values() {
                    surface.shared.record_error(reason.clone());
                }
                continue;
            }
        }
        // The tree that shows these frames is committed: the page may open
        // its holes over them now.
        for (notifier, generation) in reveals {
            notifier.fire(generation);
        }
    }
}

impl Host {
    fn new(
        container: HWND,
        webview_origin: (i32, i32),
        client: (u32, u32),
    ) -> Result<Self, String> {
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[
                    D3D_FEATURE_LEVEL_11_0,
                    D3D_FEATURE_LEVEL_10_1,
                    D3D_FEATURE_LEVEL_10_0,
                ]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(hr("D3D11CreateDevice (hardware, BGRA)"))?;
            let device: ID3D11Device = device.ok_or("D3D11CreateDevice returned no device")?;
            let context: ID3D11DeviceContext =
                context.ok_or("D3D11CreateDevice returned no immediate context")?;
            let dxgi_device: IDXGIDevice =
                device.cast().map_err(hr("ID3D11Device -> IDXGIDevice"))?;
            let factory: IDXGIFactory2 = dxgi_device
                .GetAdapter()
                .map_err(hr("IDXGIDevice::GetAdapter"))?
                .GetParent()
                .map_err(hr("IDXGIAdapter::GetParent(IDXGIFactory2)"))?;
            let dcomp: IDCompositionDevice =
                DCompositionCreateDevice(&dxgi_device).map_err(hr("DCompositionCreateDevice"))?;
            let target = dcomp.CreateTargetForHwnd(container, false).map_err(hr(
                "CreateTargetForHwnd(WebView2 container, topmost = FALSE)",
            ))?;
            let root = dcomp.CreateVisual().map_err(hr("CreateVisual (root)"))?;
            target
                .SetRoot(&root)
                .map_err(hr("IDCompositionTarget::SetRoot"))?;

            let pipeline = Pipeline::new(&device)?;

            let ground_swapchain = create_swapchain(&factory, &device, 1, 1)?;
            let ground_visual = dcomp.CreateVisual().map_err(hr("CreateVisual (ground)"))?;
            ground_visual
                .SetContent(&ground_swapchain)
                .map_err(hr("ground SetContent"))?;
            ground_visual
                .SetBitmapInterpolationMode(DCOMPOSITION_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR)
                .map_err(hr("ground SetBitmapInterpolationMode"))?;
            ground_visual
                .SetBorderMode(DCOMPOSITION_BORDER_MODE_HARD)
                .map_err(hr("ground SetBorderMode"))?;
            let scale = dcomp
                .CreateScaleTransform()
                .map_err(hr("CreateScaleTransform (ground)"))?;
            ground_visual
                .SetTransform(&scale)
                .map_err(hr("ground SetTransform"))?;

            let mut host = Host {
                device,
                context,
                factory,
                dcomp,
                _target: target,
                root,
                ground: Ground {
                    visual: ground_visual,
                    swapchain: ground_swapchain,
                    scale,
                    attached: false,
                },
                pipeline,
                webview_origin,
                surfaces: HashMap::new(),
            };
            host.size_ground(client.0, client.1)?;
            host.dcomp.Commit().map_err(hr("initial Commit"))?;
            Ok(host)
        }
    }

    /// Apply one command. Returns whether the tree changed (needs a commit).
    fn handle(&mut self, command: Command, reveals: &mut Vec<(ShownNotifier, u64)>) -> bool {
        match command {
            Command::Create {
                id,
                fit,
                shown,
                shared,
                reply,
            } => {
                let _ = reply.send(self.create_surface(id, fit, shown, shared));
                false
            }
            Command::Geometry { id, geometry } => {
                let Some(mut surface) = self.surfaces.remove(&id) else {
                    return false;
                };
                let result = self.apply_geometry(&mut surface, geometry, reveals);
                if let Err(reason) = result {
                    surface
                        .shared
                        .record_error(format!("native surface {id} geometry: {reason}"));
                }
                self.surfaces.insert(id, surface);
                true
            }
            Command::Present { id } => {
                let Some(mut surface) = self.surfaces.remove(&id) else {
                    return false;
                };
                surface.shared.wake_pending.store(false, Ordering::SeqCst);
                let frame = surface
                    .shared
                    .slot
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
                if let Some(frame) = frame {
                    let result = self.present_frame(&mut surface, frame, reveals);
                    if let Err(reason) = result {
                        surface
                            .shared
                            .record_error(format!("native surface {id} render: {reason}"));
                    }
                }
                self.surfaces.insert(id, surface);
                false
            }
            Command::Destroy { id } => match self.surfaces.remove(&id) {
                Some(surface) if surface.attached => {
                    let _ = unsafe { self.root.RemoveVisual(&surface.visual) };
                    true
                }
                _ => false,
            },
            Command::Ground { rgb } => {
                if let Err(reason) = self.paint_ground(rgb) {
                    tracing::error!("native render ground color: {reason}");
                    for surface in self.surfaces.values() {
                        surface
                            .shared
                            .record_error(format!("native render ground color: {reason}"));
                    }
                }
                true
            }
            Command::ClientSize { width, height } => {
                if let Err(reason) = self.size_ground(width, height) {
                    tracing::error!("native render ground resize: {reason}");
                }
                true
            }
        }
    }

    fn size_ground(&mut self, width: u32, height: u32) -> Result<(), String> {
        unsafe {
            self.ground
                .scale
                .SetScaleX2(width.max(1) as f32)
                .map_err(hr("ground SetScaleX"))?;
            self.ground
                .scale
                .SetScaleY2(height.max(1) as f32)
                .map_err(hr("ground SetScaleY"))?;
        }
        Ok(())
    }

    fn paint_ground(&mut self, rgb: [u8; 3]) -> Result<(), String> {
        let color = [
            f32::from(rgb[0]) / 255.0,
            f32::from(rgb[1]) / 255.0,
            f32::from(rgb[2]) / 255.0,
            1.0,
        ];
        unsafe {
            let buffer: ID3D11Texture2D = self
                .ground
                .swapchain
                .GetBuffer(0)
                .map_err(hr("ground GetBuffer"))?;
            let mut view = None;
            self.device
                .CreateRenderTargetView(&buffer, None, Some(&mut view))
                .map_err(hr("ground CreateRenderTargetView"))?;
            let view = view.ok_or("ground CreateRenderTargetView returned nothing")?;
            self.context.ClearRenderTargetView(&view, &color);
            self.ground
                .swapchain
                .Present(0, DXGI_PRESENT(0))
                .ok()
                .map_err(hr("ground Present"))?;
            if !self.ground.attached {
                // insertAbove = TRUE with no reference: below every sibling.
                self.root
                    .AddVisual(&self.ground.visual, true, None)
                    .map_err(hr("AddVisual (ground)"))?;
                self.ground.attached = true;
            }
        }
        tracing::info!(
            "[native-render] underlay ground color is now #{:02x}{:02x}{:02x} (--bg-base)",
            rgb[0],
            rgb[1],
            rgb[2]
        );
        Ok(())
    }

    fn create_surface(
        &mut self,
        id: u64,
        fit: SurfaceFit,
        shown: ShownNotifier,
        shared: Arc<SurfaceShared>,
    ) -> Result<(), String> {
        // Created hidden at a 1x1 extent: not in the tree until a visible
        // geometry arrives.
        let swapchain = create_swapchain(&self.factory, &self.device, 1, 1)?;
        let visual = unsafe {
            let visual = self
                .dcomp
                .CreateVisual()
                .map_err(hr("CreateVisual (surface)"))?;
            visual
                .SetContent(&swapchain)
                .map_err(hr("surface SetContent"))?;
            visual
        };
        self.surfaces.insert(
            id,
            Surface {
                visual,
                swapchain,
                target_view: None,
                extent: (1, 1),
                planes: None,
                colorspace: ColorSpace::default(),
                fit,
                geometry: SurfaceGeometry {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    dpr: 1.0,
                    corner_radius: 0.0,
                    visible: false,
                    generation: 0,
                    mirrored: false,
                },
                attached: false,
                shown,
                confirmed: 0,
                shared,
            },
        );
        Ok(())
    }

    fn apply_geometry(
        &mut self,
        surface: &mut Surface,
        geometry: SurfaceGeometry,
        reveals: &mut Vec<(ShownNotifier, u64)>,
    ) -> Result<(), String> {
        surface.geometry = geometry;
        let extent = swapchain_extent(&geometry);
        if extent != surface.extent {
            // Every reference to the old buffers goes before ResizeBuffers.
            surface.target_view = None;
            unsafe {
                self.context.OMSetRenderTargets(None, None);
                surface
                    .swapchain
                    .ResizeBuffers(
                        0,
                        extent.0,
                        extent.1,
                        DXGI_FORMAT_UNKNOWN,
                        DXGI_SWAP_CHAIN_FLAG(0),
                    )
                    .map_err(hr("ResizeBuffers"))?;
            }
            surface.extent = extent;
        }
        let (x, y) = visual_offset(self.webview_origin, &geometry);
        unsafe {
            surface.visual.SetOffsetX2(x).map_err(hr("SetOffsetX"))?;
            surface.visual.SetOffsetY2(y).map_err(hr("SetOffsetY"))?;
            if geometry.visible && !surface.attached {
                // insertAbove = FALSE with no reference: above every sibling
                // (the ground and the other surfaces).
                self.root
                    .AddVisual(&surface.visual, false, None)
                    .map_err(hr("AddVisual (surface)"))?;
                surface.attached = true;
                let (lx, ly, lw, lh) = geometry.logical_rect();
                tracing::debug!(
                    "[native-diag] native-render surface {} shown at physical {x},{y} {}x{} \
                     (logical {lx},{ly} {lw}x{lh}, dpr {:.3})",
                    surface.shown.surface_id().0,
                    extent.0,
                    extent.1,
                    geometry.dpr
                );
            } else if !geometry.visible && surface.attached {
                self.root
                    .RemoveVisual(&surface.visual)
                    .map_err(hr("RemoveVisual (surface)"))?;
                surface.attached = false;
            }
        }
        if geometry.visible {
            // Redraw the retained frame at the new size / radius.
            self.draw(surface, reveals)?;
        }
        Ok(())
    }

    fn present_frame(
        &mut self,
        surface: &mut Surface,
        frame: DecodedFrameHandle,
        reveals: &mut Vec<(ShownNotifier, u64)>,
    ) -> Result<(), String> {
        // On Windows `CpuI420` is the only variant that exists today; the arm
        // below keeps this honest if a GPU-resident one is ever added.
        #[allow(unreachable_patterns)]
        let (data, width, height, colorspace) = match frame {
            DecodedFrameHandle::CpuI420 {
                data,
                width,
                height,
                colorspace,
            } => (data, width, height, colorspace),
            other => {
                return Err(format!(
                    "a GPU-resident handle ({other:?}) reached the Direct3D surface, which \
                     uploads CPU I420 only"
                ))
            }
        };
        self.upload(surface, &data, width, height)?;
        surface.colorspace = colorspace;
        if surface.geometry.visible {
            self.draw(surface, reveals)?;
        }
        Ok(())
    }

    /// Upload one I420 frame into the surface's textures, (re)creating them
    /// when the frame size changes.
    fn upload(
        &self,
        surface: &mut Surface,
        data: &[u8],
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            return Err(format!(
                "frame {width}x{height} is not a drawable I420 size"
            ));
        }
        if width > MAX_EXTENT || height > MAX_EXTENT {
            return Err(format!(
                "frame {width}x{height} exceeds the {MAX_EXTENT}px texture limit"
            ));
        }
        let expected = PixelFormat::I420.frame_size(width, height);
        if data.len() < expected {
            return Err(format!(
                "I420 frame {width}x{height} carries {} bytes, needs {expected}",
                data.len()
            ));
        }
        let stale = surface
            .planes
            .as_ref()
            .is_none_or(|planes| planes.width != width || planes.height != height);
        if stale {
            surface.planes = Some(self.create_planes(width, height)?);
        }
        let planes = surface.planes.as_ref().ok_or("plane textures missing")?;
        let (w, h) = (width as usize, height as usize);
        let (cw, ch) = (w / 2, h / 2);
        let offsets = [0, w * h, w * h + cw * ch];
        let pitches = [w, cw, cw];
        unsafe {
            for index in 0..3 {
                self.context.UpdateSubresource(
                    &planes.textures[index],
                    0,
                    None,
                    data[offsets[index]..].as_ptr().cast(),
                    pitches[index] as u32,
                    0,
                );
            }
        }
        Ok(())
    }

    fn create_planes(&self, width: u32, height: u32) -> Result<Planes, String> {
        let make = |w: u32,
                    h: u32|
         -> Result<(ID3D11Texture2D, Option<ID3D11ShaderResourceView>), String> {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            unsafe {
                let mut texture = None;
                self.device
                    .CreateTexture2D(&desc, None, Some(&mut texture))
                    .map_err(hr("CreateTexture2D (plane)"))?;
                let texture = texture.ok_or("CreateTexture2D returned nothing")?;
                let mut view = None;
                self.device
                    .CreateShaderResourceView(&texture, None, Some(&mut view))
                    .map_err(hr("CreateShaderResourceView (plane)"))?;
                Ok((texture, view))
            }
        };
        let (y, y_view) = make(width, height)?;
        let (u, u_view) = make(width / 2, height / 2)?;
        let (v, v_view) = make(width / 2, height / 2)?;
        Ok(Planes {
            textures: [y, u, v],
            views: [y_view, u_view, v_view],
            width,
            height,
        })
    }

    /// Draw the retained frame into the surface's swapchain and present it.
    /// Records a reveal when a frame was drawn at a visible geometry of a
    /// generation not yet confirmed (fired after the batch commits).
    fn draw(
        &mut self,
        surface: &mut Surface,
        reveals: &mut Vec<(ShownNotifier, u64)>,
    ) -> Result<(), String> {
        let Some(planes) = surface.planes.as_ref() else {
            // Nothing decoded yet: leave the swapchain as it is.
            return Ok(());
        };
        unsafe {
            if surface.target_view.is_none() {
                let buffer: ID3D11Texture2D =
                    surface.swapchain.GetBuffer(0).map_err(hr("GetBuffer"))?;
                let mut view = None;
                self.device
                    .CreateRenderTargetView(&buffer, None, Some(&mut view))
                    .map_err(hr("CreateRenderTargetView"))?;
                surface.target_view = view;
            }
            let view = surface
                .target_view
                .clone()
                .ok_or("CreateRenderTargetView returned nothing")?;
            let (width, height) = surface.extent;
            let constants = shader_constants(
                surface.colorspace,
                surface.fit,
                &surface.geometry,
                (width, height),
                (planes.width, planes.height),
            );
            let ctx = &self.context;
            ctx.UpdateSubresource(
                &self.pipeline.constants,
                0,
                None,
                (&constants as *const ShaderConstants).cast(),
                0,
                0,
            );
            ctx.OMSetRenderTargets(Some(&[Some(view.clone())]), None);
            ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: width as f32,
                Height: height as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
            ctx.ClearRenderTargetView(&view, &[0.0, 0.0, 0.0, 0.0]);
            ctx.IASetInputLayout(None);
            ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx.RSSetState(&self.pipeline.rasterizer);
            ctx.VSSetShader(&self.pipeline.vertex_shader, None);
            ctx.PSSetShader(&self.pipeline.pixel_shader, None);
            ctx.PSSetShaderResources(0, Some(&planes.views));
            ctx.PSSetSamplers(0, Some(&[Some(self.pipeline.sampler.clone())]));
            ctx.PSSetConstantBuffers(0, Some(&[Some(self.pipeline.constants.clone())]));
            ctx.Draw(3, 0);
            ctx.OMSetRenderTargets(None, None);
            surface
                .swapchain
                .Present(0, DXGI_PRESENT(0))
                .ok()
                .map_err(hr("Present"))?;
        }
        let geometry = surface.geometry;
        if geometry.visible && geometry.generation > surface.confirmed {
            surface.confirmed = geometry.generation;
            reveals.push((surface.shown.clone(), geometry.generation));
        }
        Ok(())
    }
}

fn create_swapchain(
    factory: &IDXGIFactory2,
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<IDXGISwapChain1, String> {
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: width,
        Height: height,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        Stereo: false.into(),
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        Scaling: DXGI_SCALING_STRETCH,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
        AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
        Flags: 0,
    };
    unsafe { factory.CreateSwapChainForComposition(device, &desc, None) }.map_err(hr(
        "CreateSwapChainForComposition (BGRA, premultiplied, flip-sequential)",
    ))
}

/// Compile one HLSL entry point, returning the compiler's own message on
/// failure.
fn compile_shader(
    source: &str,
    entry: &std::ffi::CStr,
    target: &std::ffi::CStr,
) -> Result<Vec<u8>, String> {
    let mut code: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let result = unsafe {
        D3DCompile(
            source.as_ptr().cast(),
            source.len(),
            PCSTR(c"native_render".as_ptr().cast()),
            None,
            None,
            PCSTR(entry.as_ptr().cast()),
            PCSTR(target.as_ptr().cast()),
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    let blob_bytes = |blob: &ID3DBlob| unsafe {
        std::slice::from_raw_parts(blob.GetBufferPointer().cast::<u8>(), blob.GetBufferSize())
            .to_vec()
    };
    match (result, code) {
        (Ok(()), Some(code)) => Ok(blob_bytes(&code)),
        (result, _) => {
            let message = errors
                .as_ref()
                .map(|blob| String::from_utf8_lossy(&blob_bytes(blob)).into_owned())
                .unwrap_or_default();
            Err(format!(
                "D3DCompile {} ({}) failed: {} {message}",
                entry.to_string_lossy(),
                target.to_string_lossy(),
                result.err().map(|e| e.to_string()).unwrap_or_default()
            ))
        }
    }
}

impl Pipeline {
    fn new(device: &ID3D11Device) -> Result<Self, String> {
        let vs_code = compile_shader(VERTEX_SHADER, c"vs_main", c"vs_4_0")?;
        let ps_code = compile_shader(PIXEL_SHADER, c"ps_main", c"ps_4_0")?;
        unsafe {
            let mut vertex_shader = None;
            device
                .CreateVertexShader(&vs_code, None, Some(&mut vertex_shader))
                .map_err(hr("CreateVertexShader"))?;
            let mut pixel_shader = None;
            device
                .CreatePixelShader(&ps_code, None, Some(&mut pixel_shader))
                .map_err(hr("CreatePixelShader"))?;

            let sampler_desc = D3D11_SAMPLER_DESC {
                Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                MipLODBias: 0.0,
                MaxAnisotropy: 1,
                ComparisonFunc: D3D11_COMPARISON_NEVER,
                BorderColor: [0.0; 4],
                MinLOD: 0.0,
                MaxLOD: D3D11_FLOAT32_MAX,
            };
            let mut sampler = None;
            device
                .CreateSamplerState(&sampler_desc, Some(&mut sampler))
                .map_err(hr("CreateSamplerState"))?;

            let rasterizer_desc = D3D11_RASTERIZER_DESC {
                FillMode: D3D11_FILL_SOLID,
                CullMode: D3D11_CULL_NONE,
                FrontCounterClockwise: false.into(),
                DepthBias: 0,
                DepthBiasClamp: 0.0,
                SlopeScaledDepthBias: 0.0,
                DepthClipEnable: true.into(),
                ScissorEnable: false.into(),
                MultisampleEnable: false.into(),
                AntialiasedLineEnable: false.into(),
            };
            let mut rasterizer = None;
            device
                .CreateRasterizerState(&rasterizer_desc, Some(&mut rasterizer))
                .map_err(hr("CreateRasterizerState"))?;

            let buffer_desc = D3D11_BUFFER_DESC {
                ByteWidth: std::mem::size_of::<ShaderConstants>() as u32,
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
                StructureByteStride: 0,
            };
            let mut constants = None;
            device
                .CreateBuffer(&buffer_desc, None, Some(&mut constants))
                .map_err(hr("CreateBuffer (constants)"))?;

            Ok(Pipeline {
                vertex_shader: vertex_shader.ok_or("CreateVertexShader returned nothing")?,
                pixel_shader: pixel_shader.ok_or("CreatePixelShader returned nothing")?,
                sampler: sampler.ok_or("CreateSamplerState returned nothing")?,
                rasterizer: rasterizer.ok_or("CreateRasterizerState returned nothing")?,
                constants: constants.ok_or("CreateBuffer returned nothing")?,
            })
        }
    }
}

// ── Send handle ──────────────────────────────────────────────────────

/// The `Send` surface handle held by the registry and the dispatch layer. Holds
/// no COM object; every operation is a message to the render thread.
pub struct WindowsVideoSurface {
    id: SurfaceId,
    tx: Sender<Command>,
    shared: Arc<SurfaceShared>,
}

impl VideoSurface for WindowsVideoSurface {
    fn new(
        _app: &tauri::AppHandle,
        surface_id: SurfaceId,
        fit: SurfaceFit,
        shown: ShownNotifier,
    ) -> Result<Self, String> {
        let tx = render_tx()?.clone();
        let shared = Arc::new(SurfaceShared {
            slot: Mutex::new(None),
            wake_pending: AtomicBool::new(false),
            error: Mutex::new(None),
        });
        // Block for the render thread's answer (this runs in spawn_blocking).
        let (reply, answer) = mpsc::channel();
        tx.send(Command::Create {
            id: surface_id.0,
            fit,
            shown,
            shared: shared.clone(),
            reply,
        })
        .map_err(|_| "the Direct3D render thread has stopped".to_string())?;
        answer.recv().map_err(|_| {
            "the Direct3D render thread stopped while creating a surface".to_string()
        })??;
        Ok(Self {
            id: surface_id,
            tx,
            shared,
        })
    }

    fn update_geometry(&mut self, geometry: SurfaceGeometry) -> Result<(), String> {
        self.tx
            .send(Command::Geometry {
                id: self.id.0,
                geometry,
            })
            .map_err(|_| "the Direct3D render thread has stopped".to_string())
    }

    fn present(&mut self, frame: DecodedFrameHandle) -> Result<(), String> {
        // A render-thread failure for this surface is surfaced here so the
        // decode worker's present-error streak tears the subscription down
        // (spec §3.7) instead of the tile staying blank.
        if let Some(err) = self
            .shared
            .error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return Err(err);
        }
        if !matches!(frame, DecodedFrameHandle::CpuI420 { .. }) {
            return Err(format!(
                "the Direct3D surface received a GPU-resident handle ({frame:?}); the Windows \
                 decode path produces CPU I420 only"
            ));
        }
        // Keep-latest: replace the pending frame and wake the render thread
        // at most once until it has taken it.
        *self.shared.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(frame);
        if !self.shared.wake_pending.swap(true, Ordering::SeqCst)
            && self.tx.send(Command::Present { id: self.id.0 }).is_err()
        {
            self.shared.wake_pending.store(false, Ordering::SeqCst);
            return Err("the Direct3D render thread has stopped".to_string());
        }
        Ok(())
    }

    fn destroy(self) {
        // Teardown runs in `Drop` so the boxed trait object the registry holds
        // is torn down the same way.
    }
}

impl Drop for WindowsVideoSurface {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Destroy { id: self.id.0 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo(x: i32, y: i32, w: u32, h: u32) -> SurfaceGeometry {
        SurfaceGeometry {
            x,
            y,
            width: w,
            height: h,
            dpr: 2.0,
            corner_radius: 8.0,
            visible: true,
            generation: 1,
            mirrored: false,
        }
    }

    #[test]
    fn bt709_rows_map_gray_to_gray_like_the_cpu_converter() {
        // Y=126, U=V=128 maps to (298*110)/(256*255) on every channel.
        let rows = yuv_to_rgb_rows(ColorSpace::Bt709);
        let expected = (298.0 * 110.0) / (256.0 * 255.0);
        for row in rows {
            let value = row[0] * 110.0;
            assert!((value - expected).abs() < 1e-4);
        }
        assert_ne!(
            yuv_to_rgb_rows(ColorSpace::Bt601)[0][2],
            rows[0][2],
            "the V coefficient of R differs by matrix"
        );
    }

    #[test]
    fn the_constant_buffer_packs_like_hlsl() {
        // Five 16-byte registers; a D3D11 constant buffer must be a multiple of 16.
        assert_eq!(std::mem::size_of::<ShaderConstants>(), 80);
        let constants = shader_constants(
            ColorSpace::Bt709,
            SurfaceFit::Contain,
            &geo(0, 0, 400, 400),
            (400, 400),
            (1280, 720),
        );
        assert_eq!(constants.size, [400.0, 400.0]);
        assert_eq!(constants.radius, 16.0, "8 logical px at dpr 2");
        assert_eq!(constants.uv_center, [0.5, 0.5]);
        assert!((constants.uv_scale[1] - 16.0 / 9.0).abs() < 1e-5);
    }

    #[test]
    fn a_mirrored_surface_flips_the_horizontal_scale() {
        let plain = shader_constants(
            ColorSpace::Bt709,
            SurfaceFit::Contain,
            &geo(0, 0, 640, 360),
            (640, 360),
            (640, 360),
        );
        let mirrored = shader_constants(
            ColorSpace::Bt709,
            SurfaceFit::Contain,
            &SurfaceGeometry {
                mirrored: true,
                ..geo(0, 0, 640, 360)
            },
            (640, 360),
            (640, 360),
        );
        assert_eq!(mirrored.uv_scale[0], -plain.uv_scale[0]);
        assert_eq!(mirrored.uv_scale[1], plain.uv_scale[1]);
    }

    #[test]
    fn surfaces_sit_at_the_webview_origin_plus_the_page_offset() {
        assert_eq!(visual_offset((0, 0), &geo(120, 48, 10, 10)), (120.0, 48.0));
        assert_eq!(visual_offset((8, 32), &geo(120, 48, 10, 10)), (128.0, 80.0));
        // A tile scrolled partly above the viewport keeps its true position.
        assert_eq!(visual_offset((0, 0), &geo(-20, -5, 10, 10)), (-20.0, -5.0));
    }

    #[test]
    fn swapchains_are_never_empty_or_oversized() {
        assert_eq!(swapchain_extent(&geo(0, 0, 0, 0)), (1, 1));
        assert_eq!(swapchain_extent(&geo(0, 0, 1920, 1080)), (1920, 1080));
        assert_eq!(swapchain_extent(&geo(0, 0, 40_000, 9)), (MAX_EXTENT, 9));
    }
}
