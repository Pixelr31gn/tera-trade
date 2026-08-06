/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 2026-07-29: static export for the 1.4 .exe deliverable (see
  // scripts/build-exe.mjs) -- confirmed clean (no middleware, no dynamic
  // route segments, no next/image, no Server Actions, no API routes, every
  // page is "use client"). Doesn't affect `next dev`/`next start` at all,
  // only `next build`'s output shape.
  output: "export",
};

export default nextConfig;
