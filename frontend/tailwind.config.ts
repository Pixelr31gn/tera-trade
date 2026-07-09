import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        background: "#0a0c10",
        surface: "#12151b",
        border: "#232a35",
        accent: "#3b9dff",
        good: "#10b981",
        bad: "#ef4444",
        warn: "#f5a623",
      },
      boxShadow: {
        glass: "0 8px 32px rgba(0,0,0,0.45)",
        "glow-accent": "0 0 24px rgba(59,157,255,0.25)",
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
