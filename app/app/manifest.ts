import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Автобус хөтөч",
    short_name: "Автобус",
    description: "Хараагүй зорчигчийг зөв автобусны хаалга хүртэл хөтөлнө.",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
