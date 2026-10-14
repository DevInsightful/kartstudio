import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // One group of 20 jobs can carry up to 40 images at 10 MB each.
      bodySizeLimit: "420mb",
    },
  },
};

export default nextConfig;
