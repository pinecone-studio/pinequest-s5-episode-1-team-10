"use client";

// Screen-reader mode: one plain page per step, in reading order: a heading saying where you are
// (focused on every new screen, so TalkBack / VoiceOver announces it), one status line, then big
// buttons. No custom gestures: the screen reader's own swipe and double tap do everything.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { phrase, type PhraseKey } from "../lib/speech";
import type { MenuItem } from "./VoiceMenu";

interface Props {
  title: string;
  status: string;
  actions: MenuItem[];
  children?: ReactNode; // camera view, ride progress
}

const NUMBERED = 8;

// "Энэ дэлгэцэнд 3 товч байна. 1. Камер нээх. 2. ..." so TalkBack / VoiceOver reads every
// button when the set appears, not only the heading that just took focus.
function buttonAnnouncement(actions: MenuItem[]): string {
  if (!actions.length) {
    return "";
  }
  const head = actions.length <= NUMBERED ? phrase(("buttons_" + actions.length) as PhraseKey) : "";
  const names = actions
    .map(function (item, i) {
      return i + 1 + ". " + item.label;
    })
    .join(". ");
  return head ? head + " " + names + "." : names + ".";
}

function fullAnnouncement(actions: MenuItem[], title: string, status: string): string {
  return [title, status, buttonAnnouncement(actions), phrase("menu_hear_again")].filter(function (item) {
    return item.trim() !== "";
  }).join(" ");
}

export default function SrScreen({ title, status, actions, children }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef<HTMLParagraphElement>(null);
  const labels = actions
    .map(function (item) {
      return item.label;
    })
    .join("|");
  const seen = useRef("");
  const [buttonsSaid, setButtonsSaid] = useState("");

  useEffect(
    function () {
      if (heading.current) {
        heading.current.focus();
      }
    },
    [title],
  );

  useEffect(
    function () {
      // Status has its own live region, so a new message does not read every button again.
      const signature = title + "|" + labels;
      if (!labels || seen.current === signature) {
        return;
      }
      seen.current = signature;
      setButtonsSaid(buttonAnnouncement(actions) + " " + phrase("menu_hear_again"));
    },
    [title, labels, actions],
  );

  // Same text will not be spoken twice by a live region, so clear it and set it on the next frame.
  function hearAgain(): void {
    const text = fullAnnouncement(actions, title, status);
    setButtonsSaid("");
    window.setTimeout(function () {
      setButtonsSaid(text);
      if (live.current) {
        live.current.focus();
      }
    }, 30);
  }

  return (
    <section className="screen">
      <h1 ref={heading} tabIndex={-1} className="title">
        {title}
      </h1>
      {/* Always in the page (empty or not) so every new message is announced, not only new screens. */}
      <p className="status" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </p>
      {/* Separate from the status line: a new button set is its own announcement. */}
      <p ref={live} className="sr-only" tabIndex={-1} aria-live="polite" aria-atomic="true">
        {buttonsSaid}
      </p>
      {children}
      <p id="sr-activate-hint" className="sr-only">
        {phrase("double_tap_to_choose")}
      </p>
      <div className="actions">
        {actions.map(function (item) {
          return (
            <button
              key={item.id}
              type="button"
              className="action"
              aria-label={item.label}
              aria-describedby="sr-activate-hint"
              onClick={item.onActivate}
            >
              {item.label}
            </button>
          );
        })}
        {actions.length > 0 && (
          <button type="button" className="action" aria-describedby="sr-activate-hint" onClick={hearAgain}>
            {phrase("menu_hear_again")}
          </button>
        )}
      </div>
    </section>
  );
}
