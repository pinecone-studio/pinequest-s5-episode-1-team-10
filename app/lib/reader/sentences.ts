// Recognised lines (in reading order) -> sentences to read aloud and step through.
// Lines arrive a few at a time while the rest of the page is still being recognised, so this keeps
// the unfinished tail until more lines come (or the page ends).

export interface PageLine {
  text: string;
  conf: number; // 0..1, mean character confidence
  breakAfter: boolean; // a paragraph, column or heading ends after this line
}

export interface Sentence {
  text: string; // as printed (shown, and read by the phone's voice if needed)
  unsure: boolean; // has a line read with low confidence (a soft tone before it)
  unclear: number; // lines left out because they couldn't be read ("тодорхойгүй мөр")
}

// Below UNCLEAR a line is not read at all (measured: ~70% of its characters right); below UNSURE it is
// read after a soft tone (75-95% right); above, 95-99% right.
export const UNCLEAR = 0.6;
export const UNSURE = 0.8;

const LOWER = /^[a-zа-яёөү]/;
const HYPHEN = /[-­‐‑]$/;
// Not sentence ends: initials ("Д. Сүхбаатар") and common abbreviations.
const ABBREVIATIONS = ["г.м", "ж.нь", "Ж.нь", "т.г", "т.б", "гм", "др", "тр", "мэт.г"];

function endsSentence(before: string, after: string): boolean {
  if (!after) {
    return true;
  }
  if (!/^[\s]*["«“(\-–—]?[A-ZА-ЯЁӨҮ0-9]/.test(after)) {
    return false;
  }
  const word = before.split(/\s+/).pop() ?? "";
  if (/^[A-ZА-ЯЁӨҮ]\.$/.test(word)) {
    return false; // an initial
  }
  const bare = word.replace(/\.$/, "");
  return ABBREVIATIONS.indexOf(bare) < 0;
}

// Splits text into sentences at . ! ? … followed by a capital letter or a digit.
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?…]+["»”)]?(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (endsSentence(text.slice(start, end), text.slice(end))) {
      const s = text.slice(start, end).trim();
      if (s) {
        out.push(s);
      }
      start = end;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) {
    out.push(rest);
  }
  return out;
}

export class SentenceBuilder {
  private pending = ""; // text of the paragraph so far that isn't a finished sentence yet
  private pendingUnsure = false;
  private pendingUnclear = 0;
  private lastHyphen = false;

  // Adds lines; returns the sentences they finished. `final`: the page is done, flush everything.
  add(lines: PageLine[], final: boolean): Sentence[] {
    const out: Sentence[] = [];
    for (const item of lines) {
      const text = item.text.trim();
      if (item.conf < UNCLEAR || !text) {
        if (text) {
          this.pendingUnclear++;
        }
      } else {
        if (this.lastHyphen && LOWER.test(text)) {
          this.pending = this.pending.replace(HYPHEN, "") + text;
        } else {
          this.pending = this.pending ? this.pending + " " + text : text;
        }
        this.lastHyphen = HYPHEN.test(text);
        if (item.conf < UNSURE) {
          this.pendingUnsure = true;
        }
      }
      this.flush(out, item.breakAfter);
    }
    if (final) {
      this.flush(out, true);
    }
    return out;
  }

  // Finished sentences out of the pending text; `all`: the paragraph ended, so the tail is one too.
  private flush(out: Sentence[], all: boolean): void {
    if (all) {
      this.lastHyphen = false;
    }
    const parts = splitSentences(this.pending);
    const done = all ? parts : parts.slice(0, -1);
    for (let i = 0; i < done.length; i++) {
      out.push({ text: done[i], unsure: this.pendingUnsure, unclear: i === 0 ? this.pendingUnclear : 0 });
    }
    if (done.length) {
      this.pendingUnclear = 0;
      this.pendingUnsure = false;
    }
    this.pending = all ? "" : parts.length ? parts[parts.length - 1] : "";
    if (all && this.pendingUnclear) {
      out.push({ text: "", unsure: false, unclear: this.pendingUnclear });
      this.pendingUnclear = 0;
    }
  }
}
