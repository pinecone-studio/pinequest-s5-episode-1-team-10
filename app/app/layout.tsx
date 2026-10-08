import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Автобус хөтөч",
  description: "Хараагүй зорчигчийг зөв автобусны хаалга хүртэл хөтөлнө.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="mn">
      <body>{children}</body>
    </html>
  );
}
