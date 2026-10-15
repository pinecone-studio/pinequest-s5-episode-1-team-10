import type { Metadata } from "next";
import Reader from "../../components/Reader";

export const metadata: Metadata = {
  title: "Бичиг уншигч",
  description: "Ном, сонин, захидал, шошгыг утасны камераар уншиж, монгол хэлээр чангаар уншина.",
};

export default function ReadPage() {
  return <Reader />;
}
