import type { MetadataRoute } from "next";

// Installable app (home screen icon, full screen, no browser bar). Icons: scripts/make_icons.py.
// No install popup: only a button on the start screen (components/InstallButton.tsx), shown until installed.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "bus-khutuch",
    short_name: "bus-khutuch",
    description: "Хараагүй зорчигчийг зөв автобусны хаалга хүртэл хөтөлнө.",
    lang: "mn",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
