// IoU box tracker. A track decides from two agreeing reads on different frames (lib/judge.ts).
// One read never decides, and a contradicting route number clears the track.
import type { Verdict } from "../../shared/contract";
import { iou, type Box } from "./detector";
import { applyRead, type CountedRead } from "./judge";

export const VOTE_WINDOW = 7; // shown on the debug overlay only; the decision itself is two reads
const MATCH_IOU = 0.3;
const LOST_AFTER_MS = 1500;

export type Decision = "checking" | Verdict;

export interface Track {
  id: number;
  box: Box;
  lastSeen: number;
  votes: Verdict[]; // agreeing reads, for the overlay
  confs: number[]; // confidence of each vote, same order
  reads: CountedRead[];
  decision: Decision;
  announced: Decision; // last decision spoken to the rider
  pending: boolean; // a /verify request is in flight
  lastAsked: number;
  lastAnswer: number; // when /verify last answered for this bus (or when it was first seen)
  seenAt: number; // first frame of this track: decision time is measured from here
  vx: number; // horizontal speed of the box centre, px/ms, smoothed (+ = moving right)
}

let nextId = 1;

// Match each detection to the best-overlapping live track, else start a new track.
export function updateTracks(tracks: Track[], boxes: Box[], now: number): Track[] {
  const live = tracks.filter(function (item) {
    return now - item.lastSeen < LOST_AFTER_MS;
  });
  const used = new Set<number>();
  boxes.forEach(function (item) {
    let best: Track | null = null;
    let bestIou = MATCH_IOU;
    for (const t of live) {
      const overlap = iou(t.box, item);
      if (!used.has(t.id) && overlap > bestIou) {
        best = t;
        bestIou = overlap;
      }
    }
    if (best) {
      const t: Track = best;
      const dt = Math.max(1, now - t.lastSeen);
      const dx = item.x + item.w / 2 - (t.box.x + t.box.w / 2);
      t.vx = 0.7 * t.vx + 0.3 * (dx / dt);
      t.box = item;
      t.lastSeen = now;
      used.add(t.id);
    } else {
      const t: Track = {
        id: nextId++,
        box: item,
        lastSeen: now,
        votes: [],
        confs: [],
        reads: [],
        decision: "checking",
        announced: "checking",
        pending: false,
        lastAsked: 0,
        lastAnswer: now,
        seenAt: now,
        vx: 0,
      };
      live.push(t);
      used.add(t.id);
    }
  });
  return live;
}

// Two reads of the same route number, from different frames, both at confidence >= 0.8.
// A different number clears the track. A read without a route number is ignored.
export function addVote(track: Track, verdict: Verdict, confidence: number, number: string | null, frame: number): void {
  if (!number || verdict === "unsure") {
    return;
  }
  const judged = applyRead(track.reads, { verdict: verdict, confidence: confidence, number: number, frame: frame });
  track.reads = judged.reads;
  track.votes = judged.reads.map(function (item) {
    return item.verdict;
  });
  track.confs = judged.reads.map(function (item) {
    return item.confidence;
  });
  track.decision = judged.decision;
}
