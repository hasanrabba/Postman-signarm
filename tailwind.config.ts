import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        signal: {
          bg: "#0b0d12",
          panel: "#12151c",
          border: "#1f242e",
          muted: "#6b7280",
          text: "#e5e7eb",
          accent: "#7c5cff",
          accent2: "#22d3ee",
          ok: "#22c55e",
          warn: "#f59e0b",
          err: "#ef4444",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
