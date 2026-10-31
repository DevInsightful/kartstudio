import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Proxy buffers incoming requests before Server Actions parse their forms.
    // Match the existing upload cap and leave room for multipart boundaries.
    proxyClientMaxBodySize: "420mb",
    serverActions: {
      // One group of 20 jobs can carry up to 40 images at 10 MB each.
      bodySizeLimit: "420mb",
    },
  },
};

export default nextConfig;
