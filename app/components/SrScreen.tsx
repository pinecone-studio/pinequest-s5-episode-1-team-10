"use client";

// Screen-reader mode: one plain page per step, in reading order: a heading saying where you are
// (focused on every new screen, so TalkBack / VoiceOver announces it), one status line, then big
// buttons. No custom gestures: the screen reader's own swipe and double tap do everything.
// An empty status line is left out (unless it is a live region), so it never costs a swipe: home is
// heading, "Автобус", "Ном унших".
import { useEffect, useRef, type ReactNode } from "react";
import type { MenuItem } from "./VoiceMenu";

interface Props {
  title: string;
  spokenTitle?: string; // what the screen reader says instead, when the title has a route code ("Ч:29Б")
  stepId: string; // focus moves when the step changes, even if the heading text stays the same
  status: string;
  live: boolean; // true: VoiceOver reads status changes. false: the app's own voice is reading them.
  actions: MenuItem[];
  large?: number; // the first this many buttons are the screen's big choices (home's two halves)
  children?: ReactNode; // camera view, ride progress
  footer?: ReactNode; // after the buttons (home: install)
}

export default function SrScreen({ title, spokenTitle, stepId, status, live, actions, large = 0, children, footer }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(
    function () {
      if (heading.current) {
        heading.current.focus();
      }
    },
    [stepId],
  );

  return (
    <section className="screen">
      {/* With a spoken form, the heading's name is only the hidden words: read once, digits never. */}
      <h1 ref={heading} tabIndex={-1} className="title">
        {spokenTitle ? (
          <>
            <span aria-hidden="true">{title}</span>
            <span className="sr-only">{spokenTitle}</span>
          </>
        ) : (
          title
        )}
      </h1>
      {/* A live region talks over the app's Mongolian clip. VoiceOver can still read this by swiping.
          It stays in the page while live, even empty: a live region added with its text isn't read. */}
      {(status || live) && (
        <p className="status" role={live ? "status" : undefined} aria-live={live ? "polite" : undefined} aria-atomic={live ? true : undefined}>
          {status}
        </p>
      )}
      {children}
      <div className="actions">
        {actions.map(function (item, i) {
          return (
            <button key={item.id} className={i < large ? "action start-half" : "action"} onClick={item.onActivate}>
              {item.label}
            </button>
          );
        })}
      </div>
      {footer}
    </section>
  );
}
