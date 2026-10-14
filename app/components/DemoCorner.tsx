"use client";

// The pitch demo (public/demo/index.html) as a small still preview in the corner; a tap opens it
// full screen and starts the guided tour with sound, ✕, Esc or leaving full screen shrinks it back.
// For judges and sighted helpers; ?nodemo hides it.
import { useEffect, useRef, useState } from "react";

export default function DemoCorner() {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(function () {
    // Read after mount: the URL isn't known while rendering on the server.
    const hide = new URLSearchParams(window.location.search).has("nodemo");
    const t = setTimeout(function () {
      setHidden(hide);
    }, 0);
    return function () {
      clearTimeout(t);
    };
  }, []);

  function tell(mode: "mini" | "full"): void {
    const win = frame.current ? frame.current.contentWindow : null;
    if (win) {
      win.postMessage({ demo: mode }, window.location.origin);
    }
  }

  function enlarge(): void {
    setOpen(true);
    tell("full");
    // iPhone Safari has no full-screen API for page elements: the open player already fills the screen.
    const el = box.current;
    if (el && typeof el.requestFullscreen === "function" && !document.fullscreenElement) {
      el.requestFullscreen().catch(function () {});
    }
  }

  function shrink(): void {
    setOpen(false);
    tell("mini");
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {});
    }
  }

  useEffect(
    function () {
      if (!open) {
        return;
      }
      function close(): void {
        setOpen(false);
        const win = frame.current ? frame.current.contentWindow : null;
        if (win) {
          win.postMessage({ demo: "mini" }, window.location.origin);
        }
      }
      function onKey(e: KeyboardEvent): void {
        if (e.key === "Escape") {
          close();
        }
      }
      // Esc in full screen only leaves full screen (no keydown): shrink then too.
      function onFullscreen(): void {
        if (!document.fullscreenElement) {
          close();
        }
      }
      window.addEventListener("keydown", onKey);
      document.addEventListener("fullscreenchange", onFullscreen);
      return function () {
        window.removeEventListener("keydown", onKey);
        document.removeEventListener("fullscreenchange", onFullscreen);
      };
    },
    [open],
  );

  if (hidden) {
    return null;
  }
  return (
    <div ref={box} className={open ? "demo-corner open" : "demo-corner"} role={open ? "dialog" : undefined} aria-label="Демо">
      <iframe ref={frame} src="/demo/index.html?mode=mini" title="Автобус Хөтөч демо" allow="autoplay" tabIndex={open ? 0 : -1} />
      {open ? (
        <button className="demo-close" onClick={shrink} aria-label="Демог жижигрүүлэх">
          ✕
        </button>
      ) : (
        <button className="demo-tap" onClick={enlarge} aria-label="Демог томруулж үзэх">
          <span>Демо ▸</span>
        </button>
      )}
    </div>
  );
}
