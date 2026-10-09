"use client";

// The pitch demo (public/demo/index.html) as a small live preview in the corner; a tap opens the
// full demo page, ✕ or Esc shrinks it back. For judges and sighted helpers; ?nodemo hides it.
import { useEffect, useRef, useState } from "react";

export default function DemoCorner() {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

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
  }

  function shrink(): void {
    setOpen(false);
    tell("mini");
  }

  useEffect(
    function () {
      if (!open) {
        return;
      }
      function onKey(e: KeyboardEvent): void {
        if (e.key === "Escape") {
          setOpen(false);
          const win = frame.current ? frame.current.contentWindow : null;
          if (win) {
            win.postMessage({ demo: "mini" }, window.location.origin);
          }
        }
      }
      window.addEventListener("keydown", onKey);
      return function () {
        window.removeEventListener("keydown", onKey);
      };
    },
    [open],
  );

  if (hidden) {
    return null;
  }
  return (
    <div className={open ? "demo-corner open" : "demo-corner"} role={open ? "dialog" : undefined} aria-label="Демо">
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
