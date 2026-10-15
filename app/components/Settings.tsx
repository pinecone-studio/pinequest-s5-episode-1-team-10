"use client";

// The one settings page (for the rider with a screen reader, or a sighted helper): how the app is
// used, the family number for SOS, typing a destination, the tutorial again. Plain form controls.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Mode } from "../lib/mode";
import FamilyContact from "./FamilyContact";

interface Props {
  mode: Mode;
  onMode: (mode: Mode) => void;
  onDestination: (text: string) => void;
  onTutorial: () => void;
  onBack: () => void;
}

export default function Settings({ mode, onMode, onDestination, onTutorial, onBack }: Props) {
  const [typed, setTyped] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(function () {
    if (heading.current) {
      heading.current.focus();
    }
  }, []);

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (typed.trim()) {
      onDestination(typed.trim());
    }
  }

  return (
    <section className="screen settings">
      <h1 ref={heading} tabIndex={-1} className="title">
        Тохиргоо
      </h1>

      <fieldset className="field">
        <legend>Ашиглах хэлбэр</legend>
        <button
          className="action"
          aria-pressed={mode === "sr"}
          onClick={function () {
            onMode("sr");
          }}
        >
          Дэлгэц уншигчтай (TalkBack, VoiceOver)
        </button>
        <button
          className="action"
          aria-pressed={mode === "voice"}
          onClick={function () {
            onMode("voice");
          }}
        >
          Апп уншина (дэлгэц уншигчгүй)
        </button>
      </fieldset>

      <FamilyContact />

      <form className="field" onSubmit={submit}>
        <label htmlFor="dest">Очих газраа бичих (туслагч)</label>
        <input
          id="dest"
          value={typed}
          onChange={function (e) {
            setTyped(e.target.value);
          }}
          placeholder="Сансар"
        />
        <button type="submit" className="action">
          Хайх
        </button>
      </form>

      <button className="action" onClick={onTutorial}>
        Заавар дахин сонсох
      </button>
      <button className="action" onClick={onBack}>
        Буцах
      </button>
    </section>
  );
}
