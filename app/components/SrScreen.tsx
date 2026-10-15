"use client";

// Screen-reader mode: one plain page per step, in reading order: a heading saying where you are
// (focused on every new screen, so TalkBack / VoiceOver announces it), one status line, then big
// buttons. No custom gestures: the screen reader's own swipe and double tap do everything.
import { useEffect, useRef, type ReactNode } from "react";
import type { MenuItem } from "./VoiceMenu";

interface Props {
  title: string;
  status: string;
  actions: MenuItem[];
  children?: ReactNode; // camera view, ride progress
}

export default function SrScreen({ title, status, actions, children }: Props) {
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
      {status && <p className="status">{status}</p>}
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
