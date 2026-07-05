import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        background: "#0b0f14",
        surface: "#121820",
        border: "#232c38",
        accent: "#4f9cff",
        good: "#2fbf71",
        bad: "#e5484d",
        warn: "#f5a623",
      },
    },
  },
  plugins: [],
};

export default config;
