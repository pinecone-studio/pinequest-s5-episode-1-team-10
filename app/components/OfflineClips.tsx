"use client";

// Mounted once in the root layout: stores the voice clips on the phone (lib/offline.ts). Renders nothing.
import { useEffect } from "react";
import { registerOffline } from "../lib/offline";

export default function OfflineClips() {
  useEffect(function () {
    registerOffline();
  }, []);
  return null;
}
