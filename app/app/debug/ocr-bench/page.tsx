import type { Metadata } from "next";
import OcrBench from "../../../components/OcrBench";

export const metadata: Metadata = {
  title: "OCR bench",
  description: "On-device sign OCR vs Azure on the bus photos in /test-fixtures/bus: accuracy and timing.",
};

export default function OcrBenchPage() {
  return <OcrBench />;
}
