"use client";

// Mounted once in the root layout: stores the voice clips on the phone (lib/offline.ts) and, with ?log=1,
// starts the phone test log (lib/reader/remoteLog.ts). Renders nothing.
import { useEffect } from "react";
import { registerOffline } from "../lib/offline";
import { startRemoteLog } from "../lib/reader/remoteLog";

export default function OfflineClips() {
  useEffect(function () {
    startRemoteLog(); // only with ?log=1 (phone testing); every page, so a reload on the bus screens shows too
    registerOffline();
  }, []);
  return null;
}
