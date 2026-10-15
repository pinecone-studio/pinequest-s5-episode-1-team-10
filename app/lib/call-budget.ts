// How many sign reads the phone may send. Azure's free tier (F0) allows 20 calls a minute for the whole
// key: a short burst when a sign comes into view, then an even pace, so that no 60 s window ever holds
// more than perMinute calls (a token bucket: burst + refill over 60 s = perMinute). Pure: time is passed in.
export interface CallBudget {
  take(now: number): boolean; // true: send one call now
  pauseUntil(at: number): void; // the server said "too many calls": nothing before this time
}

export function createCallBudget(perMinute: number, burst: number): CallBudget {
  const perMs = (perMinute - burst) / 60000;
  let tokens = burst;
  let last: number | null = null;
  let paused = 0;
  return {
    take: function (now: number): boolean {
      if (last !== null) {
        tokens = Math.min(burst, tokens + (now - last) * perMs);
      }
      last = now;
      if (now < paused || tokens < 1) {
        return false;
      }
      tokens -= 1;
      return true;
    },
    pauseUntil: function (at: number): void {
      paused = Math.max(paused, at);
      tokens = 0;
    },
  };
}
