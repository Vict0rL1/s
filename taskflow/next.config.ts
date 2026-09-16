import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // El repo tiene otra app con su propio lockfile un nivel arriba; sin esto
  // Turbopack adivina mal cuál es la raíz.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
};

export default nextConfig;
