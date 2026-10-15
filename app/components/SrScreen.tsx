"use client";

// Screen-reader mode: one plain page per step, in reading order: a heading saying where you are
// (focused on every new screen, so TalkBack / VoiceOver announces it), one status line, then big
// buttons. No custom gestures: the screen reader's own swipe and double tap do everything.
import { useEffect, useRef, type ReactNode } from "react";
import type { MenuItem } from "./VoiceMenu";

interface Props {
  title: string;
  status: string;
  live: boolean; // true: VoiceOver reads status changes. false: the app's own voice is reading them.
  actions: MenuItem[];
  children?: ReactNode; // camera view, ride progress
}

export default function SrScreen({ title, status, live, actions, children }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(
    function () {
      if (heading.current) {
        heading.current.focus();
      }
    },
    [title],
  );

  return (
    <section className="screen">
      <h1 ref={heading} tabIndex={-1} className="title">
        {title}
      </h1>
      {/* A live region talks over the app's Mongolian clip. VoiceOver can still read this by swiping. */}
      <p className="status" role={live ? "status" : undefined} aria-live={live ? "polite" : undefined} aria-atomic={live ? true : undefined}>
        {status}
      </p>
      {children}
      <div className="actions">
        {actions.map(function (item) {
          return (
            <button key={item.id} className="action" onClick={item.onActivate}>
              {item.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
