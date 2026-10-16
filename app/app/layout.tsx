import type { Metadata, Viewport } from "next";
import OfflineClips from "../components/OfflineClips";
import "./globals.css";

export const metadata: Metadata = {
  title: "Автобус хөтөч",
  description: "Хараагүй зорчигчийг зөв автобусны хаалга хүртэл хөтөлнө.",
  // iPhone "Add to Home Screen": full screen, its name and icon (Android reads app/manifest.ts).
  appleWebApp: { capable: true, title: "bus-khutuch", statusBarStyle: "black" },
  icons: { apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="mn">
      <body>
        {children}
        <OfflineClips />
      </body>
    </html>
  );
}
