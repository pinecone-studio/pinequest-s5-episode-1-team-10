// IoU box tracker + 5-of-7 vote per bus, so one bad frame or OCR read never decides.
import type { Verdict } from "../../shared/contract";
import { iou, type Box } from "./detector";

export const VOTE_WINDOW = 7;
export const VOTES_NEEDED = 5;
const MATCH_IOU = 0.3;
const LOST_AFTER_MS = 1500;

export type Decision = "checking" | Verdict;

export interface Track {
  id: number;
  box: Box;
  lastSeen: number;
  votes: Verdict[]; // newest last, at most VOTE_WINDOW
  decision: Decision;
  announced: Decision; // last decision spoken to the rider
  pending: boolean; // a /verify request is in flight
  lastAsked: number;
  lastAnswer: number; // when /verify last answered for this bus (or when it was first seen)
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
        decision: "checking",
        announced: "checking",
        pending: false,
        lastAsked: 0,
        lastAnswer: now,
        vx: 0,
      };
      live.push(t);
      used.add(t.id);
    }
  });
  return live;
}

// A verdict counts only when VOTES_NEEDED of the last VOTE_WINDOW reads agree.
export function addVote(track: Track, verdict: Verdict): void {
  track.votes = track.votes.concat(verdict).slice(-VOTE_WINDOW);
  const count = function (v: Verdict): number {
    return track.votes.filter(function (item) {
      return item === v;
    }).length;
  };
  if (count("yes") >= VOTES_NEEDED) {
    track.decision = "yes";
  } else if (count("no") >= VOTES_NEEDED) {
    track.decision = "no";
  } else if (track.votes.length >= VOTE_WINDOW) {
    track.decision = "unsure";
  } else {
    track.decision = "checking";
  }
}
