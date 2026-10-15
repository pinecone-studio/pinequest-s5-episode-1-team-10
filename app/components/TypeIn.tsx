"use client";

// Typing instead of speaking (iPhone has no Mongolian speech recognition; or the rider prefers it):
// one big labelled field and a "Болсон" button. Works with VoiceOver / TalkBack and the phone's
// keyboard dictation. The parent focuses it inside the tap that opened it (iPhone only shows the
// keyboard for a focus made during a touch).
import { forwardRef, useState, type FormEvent } from "react";

interface Props {
  label: string;
  phone?: boolean; // digits keypad
  onDone: (text: string) => void;
}

const TypeIn = forwardRef<HTMLInputElement, Props>(function TypeIn({ label, phone, onDone }, ref) {
  const [text, setText] = useState("");

  function submit(e: FormEvent): void {
    e.preventDefault();
    onDone(text.trim());
  }

  return (
    <form className="field type-in" onSubmit={submit}>
      <label htmlFor="type-in">{label}</label>
      <input
        id="type-in"
        ref={ref}
        type={phone ? "tel" : "text"}
        inputMode={phone ? "tel" : "text"}
        autoComplete={phone ? "tel" : "off"}
        enterKeyHint="done"
        value={text}
        onChange={function (e) {
          setText(e.target.value);
        }}
      />
      <button type="submit" className="action">
        Болсон
      </button>
    </form>
  );
});

export default TypeIn;
