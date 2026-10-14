"use client";

// One-time setup, for a sighted helper: the family phone number SOS texts or calls.
import { useState, type FormEvent } from "react";
import { familyNumber, saveFamilyNumber } from "../lib/family";

export default function FamilyContact() {
  const [saved, setSaved] = useState(function () {
    return typeof window === "undefined" ? "" : familyNumber();
  });
  const [typed, setTyped] = useState("");

  function save(e: FormEvent): void {
    e.preventDefault();
    setSaved(saveFamilyNumber(typed));
    setTyped("");
  }

  return (
    <form className="typed family" onSubmit={save}>
      <label htmlFor="family">Гэр бүлийн утас (яаралтай үед){saved ? ": " + saved : ""}</label>
      <input
        id="family"
        type="tel"
        inputMode="tel"
        value={typed}
        onChange={function (e) {
          setTyped(e.target.value);
        }}
        placeholder="99112233"
      />
      <button type="submit">Хадгалах</button>
    </form>
  );
}
