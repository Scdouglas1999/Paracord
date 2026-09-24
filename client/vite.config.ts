import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// The one version the app ships with. About used to carry a literal that had
// drifted four major versions behind the build, so the screen that exists to
// answer "what am I running?" answered wrong.
const appVersion: string = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
).version;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Default to HTTPS because the backend redirects HTTP→HTTPS when TLS is
  // enabled (the default).  `secure: false` accepts the self-signed cert.
  const proxyTarget = env.VITE_DEV_PROXY_TARGET || "https://localhost:8443";

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: "autoUpdate",
        manifest: {
          name: "Paracord",
          short_name: "Paracord",
          description: "A decentralized, self-hostable chat platform",
          // The Slate ground: the default theme's --bg-base, which is also the
          // loading screen's ground (index.html), so the OS launch splash, the
          // loading screen and the app are one color.
          theme_color: "#070c10",
          background_color: "#070c10",
          icons: [
            { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
            { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
            { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
            {
              src: "maskable-icon-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          navigateFallbackDenylist: [/^\/api\//, /^\/_paracord\//, /^\/gateway/, /^\/livekit/, /^\/health/],
          runtimeCaching: [],
          skipWaiting: true,
          clientsClaim: true,
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    clearScreen: false,
    // The DM decrypt worker is instantiated as a module worker
    // (`new Worker(url, { type: 'module' })`). Vite's default worker bundle
    // format is "iife", which Rollup refuses to emit once the main build is
    // code-split (manualChunks + vite-plugin-pwa). Emit ES modules to match.
    worker: {
      format: "es",
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    server: {
      port: 1420,
      strictPort: true,
      // End-to-end runs opt out of hot replacement: a concurrent source edit
      // must not remount the application in the middle of a user journey.
      hmr: env.VITE_DEV_HMR === "false" ? false : undefined,
      proxy: {
        "/health": {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
        "/_paracord": {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
        "/gateway": {
          target: proxyTarget,
          ws: true,
          changeOrigin: true,
          secure: false,
        },
        "/livekit": {
          target: proxyTarget,
          ws: true,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    envPrefix: ["VITE_", "TAURI_"],
    build: {
      target: "esnext",
      minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
      sourcemap: !!process.env.TAURI_DEBUG,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replace(/\\/g, "/");

            if (!normalized.includes("/node_modules/")) {
              return undefined;
            }

            if (
              normalized.includes("/react/")
              || normalized.includes("/react-dom/")
              || normalized.includes("/react-router")
            ) {
              return "vendor-react";
            }
            if (normalized.includes("/livekit-client/")) return "vendor-livekit";
            if (normalized.includes("/@noble/")) return "vendor-crypto";
            if (normalized.includes("/lucide-react/")) return "vendor-icons";
            if (normalized.includes("/highlight.js/") || normalized.includes("/dompurify/")) {
              return "vendor-markdown";
            }
            if (normalized.includes("/@dnd-kit/")) return "vendor-dnd";
            if (normalized.includes("/@tauri-apps/")) return "vendor-tauri";

            return undefined;
          },
        },
      },
    },
    esbuild: {
      // Strip verbose logging in production builds — keep warn/error for
      // real issues the user or support might need to see.
      drop: mode === "production" ? ["debugger"] : [],
      pure: mode === "production" ? ["console.log", "console.info"] : [],
    },
  };
});
