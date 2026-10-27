import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "2nd Brain",
    short_name: "2nd Brain",
    description: "Log what you learn. Find it by idea.",
    start_url: "/",
    display: "standalone",
    // Same as the brain's background, so launch doesn't flash a second colour.
    background_color: "#04050c",
    theme_color: "#04050c",
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png" },
    ],
  };
}
