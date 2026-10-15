// ByteTrack-style tracker. A track decides from two agreeing reads on different frames (lib/judge.ts).
// One read never decides, and a contradicting route number clears the track.
// A bus hidden for under 1.5 s stays the same track, so its reads are not thrown away.
import type { Verdict } from "../../shared/contract";
import { iou, type Box } from "./detector";
import { applyRead, type CountedRead } from "./judge";
import { motionFromBox, predictMotion, updateMotion, type Motion } from "./kalman";

export const VOTE_WINDOW = 7; // shown on the debug overlay only; the decision itself is two reads
const MATCH_IOU = 0.3;
const LOST_AFTER_MS = 1500;
const HIGH_SCORE = 0.5; // may start a new track
const LOW_SCORE = 0.1; // may only continue a track that already exists

export type Decision = "checking" | Verdict;

export interface Track {
  id: number;
  box: Box;
  motion: Motion;
  motionAt: number;
  lastSeen: number;
  votes: Verdict[]; // agreeing reads, for the overlay
  confs: number[]; // confidence of each vote, same order
  reads: CountedRead[];
  samples: number[]; // recent box widths, so a sudden shrink (someone walked in front) is not read
  aspects: number[];
  decision: Decision;
  announced: Decision; // last decision spoken to the rider
  pending: boolean; // a /verify request is in flight
  lastAsked: number;
  lastAnswer: number; // when /verify last answered for this bus (or when it was first seen)
  seenAt: number; // first frame of this track: decision time is measured from here
  vx: number; // horizontal speed of the box centre, px/ms (+ = moving right)
  locked: boolean; // the rider's bus: keep following it, never re-read the sign
}

let nextId = 1;

function boxFrom(motion: Motion, score: number): Box {
  const w = Math.max(1, motion.w.pos);
  const h = Math.max(1, motion.h.pos);
  return { x: motion.cx.pos - w / 2, y: motion.cy.pos - h / 2, w: w, h: h, score: score };
}

function blank(box: Box, now: number): Track {
  return {
    id: nextId++,
    box: box,
    motion: motionFromBox(box),
    motionAt: now,
    lastSeen: now,
    votes: [],
    confs: [],
    reads: [],
    samples: [],
    aspects: [],
    decision: "checking",
    announced: "checking",
    pending: false,
    lastAsked: 0,
    lastAnswer: now,
    seenAt: now,
    vx: 0,
    locked: false,
  };
}

function predict(track: Track, now: number): void {
  const dt = now - track.motionAt;
  if (dt <= 0) {
    return;
  }
  track.motion = predictMotion(track.motion, dt);
  track.motionAt = now;
  track.vx = track.motion.cx.vel;
  track.box = boxFrom(track.motion, track.box.score);
}

// Greedy IoU against the predicted boxes. Returns detections that matched nothing.
function associate(tracks: Track[], boxes: Box[], used: Set<number>, now: number): Box[] {
  const left: Box[] = [];
  boxes
    .slice()
    .sort(function (a, b) {
      return b.score - a.score;
    })
    .forEach(function (item) {
      let best: Track | null = null;
      let bestIou = MATCH_IOU;
      tracks.forEach(function (track) {
        if (used.has(track.id)) {
          return;
        }
        const overlap = iou(track.box, item);
        if (overlap > bestIou) {
          best = track;
          bestIou = overlap;
        }
      });
      if (!best) {
        left.push(item);
        return;
      }
      const track: Track = best;
      track.motion = updateMotion(track.motion, item);
      track.vx = track.motion.cx.vel;
      track.box = boxFrom(track.motion, item.score);
      track.lastSeen = now;
      used.add(track.id);
    });
  return left;
}

// High-score detections may start a track. Low-score ones only keep a track alive through a crowd.
export function updateTracks(tracks: Track[], boxes: Box[], now: number): Track[] {
  const live = tracks.filter(function (item) {
    return now - item.lastSeen < LOST_AFTER_MS;
  });
  live.forEach(function (item) {
    predict(item, now);
  });
  const high: Box[] = [];
  const low: Box[] = [];
  boxes.forEach(function (item) {
    if (item.score >= HIGH_SCORE) {
      high.push(item);
    } else if (item.score >= LOW_SCORE) {
      low.push(item);
    }
  });
  const used = new Set<number>();
  associate(live, high, used, now).forEach(function (item) {
    const track = blank(item, now);
    live.push(track);
    used.add(track.id);
  });
  associate(live, low, used, now);
  return live;
}

// Two reads of the same route number, from different frames, both at confidence >= 0.8.
// A different number clears the track. A read without a route number is ignored.
// Once the track is the rider's bus, later reads cannot change that.
export function addVote(track: Track, verdict: Verdict, confidence: number, number: string | null, frame: number): void {
  if (track.locked || !number || verdict === "unsure") {
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
  if (track.decision === "yes") {
    track.locked = true;
  }
}
