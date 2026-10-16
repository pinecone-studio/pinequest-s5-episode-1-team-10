// The screens of the app (components/RiderFlow.tsx) and where "Буцах" goes from each one.
//   start: with or without a screen reader, only until that choice is saved on this phone
//   home: "Автобус" or "Ном унших" (the reader, /read; its back button comes to "/", which opens on home)
//   Автобус: learn (first time) -> number (first time) -> locating -> confirmPlace, or where (no GPS)
//   -> ask -> listening / typing -> working -> confirmDest (a sound-alike) -> planned -> camera -> ride
//   -> arrived (or planned again for the second bus of a transfer).
// "Буцах" goes one screen back and is never a screen's double-tap default.
import type { Mode } from "./mode";

export type Step =
  | "start"
  | "home" // "Автобус" / "Ном унших"
  | "learn" // first-use lesson: headphones, wearing the phone, gestures, ear check
  | "locating"
  | "confirmPlace" // "Таны байршил: X. Зөв үү?" after GPS or a said place: a wrong place means a wrong bus
  | "where"
  | "whereListening"
  | "ask"
  | "listening"
  | "working"
  | "planned"
  | "camera" // find the bus, then guide to its door
  | "ride" // on the bus, until the rider's stop
  | "arrived"
  | "number" // family phone number for SOS: say it or type it?
  | "numberListening"
  | "numberConfirm" // read back digit by digit: correct?
  | "confirmDest" // the destination was a sound-alike of what was heard: "is it X?" before the trip
  | "typing" // typing instead of speaking (see typeFor)
  | "settings"; // helper / screen-reader settings: mode, family number, typed destination

export type TypeFor = "number" | "dest" | "where";

// The screens "Буцах" can open; each is entered the way the app enters it anyway (with its own speech).
export type BackTarget = "start" | "home" | "ask" | "where" | "number" | "planned";

// The home screen: the plan's two labels, and the app's name (its page title) as the heading.
export const HOME_TITLE = "Автобус хөтөч";
export const HOME_BUS = "Автобус";
export const HOME_READ = "Ном унших";

// First screen of a launch: the mode choice only until a mode is saved, then straight to home.
export function launchStep(saved: Mode | null): "start" | "home" {
  return saved ? "home" : "start";
}

export interface BackContext {
  typeFor: TypeFor; // what the typing screen is for
  numberNext: "find" | "ask"; // the number setup was opened at the start of a trip, or from "ask"
  located: boolean; // the app has a position for the rider
  placeFromGps: boolean; // confirmPlace names the GPS stop (else a stop the rider said or typed)
  workingFor: "ask" | "where"; // the wait screen is planning the trip, or looking up a said place
  settingsFrom: "ask" | "where";
}

export function backTarget(step: Step, ctx: BackContext): BackTarget | null {
  switch (step) {
    case "start":
      return null; // the first screen
    case "home":
      return "start"; // also the way to change the mode
    case "learn":
      return ctx.located ? "ask" : "home"; // replayed from Help mid-trip, or the first lesson
    case "number":
      return ctx.numberNext === "ask" ? "ask" : "home";
    case "numberListening":
    case "numberConfirm":
      return "number";
    case "locating":
    case "where":
    case "ask":
    case "arrived":
      return "home";
    case "confirmPlace":
      return ctx.placeFromGps ? "home" : "where";
    case "whereListening":
      return "where";
    case "listening":
    case "confirmDest":
    case "planned":
      return "ask";
    case "working":
      return ctx.workingFor;
    case "typing":
      return ctx.typeFor === "number" ? "number" : ctx.typeFor === "dest" ? "ask" : "where";
    case "camera":
    case "ride":
      return "planned";
    case "settings":
      return ctx.settingsFrom;
  }
}

// "Буцах" comes after a screen's `count` own options. The double-tap default stays on the screen's own
// option and is never "Буцах": a screen whose only option is "Буцах" has no default (a stray double tap
// must not leave the camera or the ride).
export function primaryWithBack(primary: number | undefined, count: number): number | undefined {
  return primary !== undefined && primary < count ? primary : undefined;
}

// "Буцах" while the app is waiting (GPS, the server, the microphone): the flow that was waiting must not
// move the screen afterwards. Each flow takes a ticket when it starts and checks it after every wait;
// cancel() makes every ticket taken before it stale.
export interface Runs {
  cancel: () => void;
  ticket: () => () => boolean;
}

export function createRuns(): Runs {
  let run = 0;
  return {
    cancel: function () {
      run++;
    },
    ticket: function () {
      const mine = run;
      return function () {
        return mine === run;
      };
    },
  };
}
