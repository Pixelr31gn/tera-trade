import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        // "Snow leopard" palette: cool granite/slate darks (the rock and
        // shadow of a high-altitude coat) with an icy glacier-blue accent
        // (the pale ice-blue of a snow leopard's eyes) -- good/bad/warn are
        // deliberately left as clear, conventional win/loss/caution colors
        // rather than reskinned, since this is a live real-money dashboard
        // and those three carry safety-relevant meaning at a glance.
        background: "#0a0e15",
        surface: "#131a23",
        border: "#28323f",
        accent: "#7dd3fc",
        good: "#10b981",
        bad: "#ef4444",
        warn: "#f5a623",
      },
      boxShadow: {
        glass: "0 8px 32px rgba(0,0,0,0.45)",
        "glow-accent": "0 0 24px rgba(125,211,252,0.25)",
        "glow-good": "0 0 24px rgba(16,185,129,0.25)",
      },
      backdropBlur: {
        xs: "2px",
      },
    },
  },
  plugins: [],
};

export default config;
