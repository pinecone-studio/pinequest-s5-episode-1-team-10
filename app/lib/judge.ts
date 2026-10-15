// Two agreeing reads from different frames, or nothing. One read never decides.
// A different route number on the same track wipes it back to unsure.
import type { Verdict } from "../../shared/contract";

export const READ_CONF = 0.8;

export interface CountedRead {
  verdict: Exclude<Verdict, "unsure">;
  confidence: number;
  number: string;
  frame: number;
}

export type JudgeDecision = "checking" | Verdict;

export function applyRead(reads: CountedRead[], next: CountedRead): { reads: CountedRead[]; decision: JudgeDecision } {
  if (next.confidence < READ_CONF) {
    return { reads: reads, decision: reads.length >= 2 ? reads[0].verdict : "checking" };
  }
  const conflict = reads.some(function (item) {
    return item.number !== next.number;
  });
  if (conflict) {
    return { reads: [], decision: "unsure" };
  }
  const seen = reads.some(function (item) {
    return item.frame === next.frame;
  });
  const kept = seen ? reads : reads.concat(next);
  const frames: number[] = [];
  kept.forEach(function (item) {
    if (frames.indexOf(item.frame) < 0) {
      frames.push(item.frame);
    }
  });
  if (frames.length >= 2) {
    return { reads: kept, decision: next.verdict };
  }
  return { reads: kept, decision: "checking" };
}
