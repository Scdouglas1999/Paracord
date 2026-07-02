import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

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
          theme_color: "#1a1a2e",
          background_color: "#1a1a2e",
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
    server: {
      port: 1420,
      strictPort: true,
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
            if (normalized.includes("/framer-motion/")) return "vendor-motion";
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
