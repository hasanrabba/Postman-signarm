import type { NextConfig } from "next";

// SIGNAL_TARGET=tauri produces a static export for the Tauri desktop build.
// API routes are stripped from that export since the Rust backend replaces
// them. The default `next build` still works as a standard web app.
const isTauri = process.env.SIGNAL_TARGET === "tauri";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  ...(isTauri
    ? {
        output: "export",
        images: { unoptimized: true },
        distDir: "out",
        // Tauri serves the frontend from a custom scheme; avoid trailing
        // slash shenanigans by keeping index.html at the root.
        trailingSlash: false,
      }
    : {}),
};

export default nextConfig;
