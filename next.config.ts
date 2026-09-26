import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded from node_modules at runtime rather than bundled (native/WASM code).
  serverExternalPackages: ["pg", "libpg-query"],
};

export default nextConfig;
