// Mongolian speech -> text with Speechmatics real-time, on every phone (iPhone included: Apple's own
// recognizer has no Mongolian). The microphone streams 16 kHz PCM over a WebSocket while the rider
// talks; our server only hands out a 60 s key (/api/stt/token), so the account key never reaches the
// phone. Measured on our Mongolian clips: final text ~1.4 s after the rider stops talking.
//   - the microphone opens at once and its audio is kept until the connection is ready, so nothing
//     said right after the beep is lost
//   - ends by itself when the rider stops talking (Speechmatics EndOfUtterance), or on stop()
//   - the free account allows 2 sessions at a time: a busy start is retried, then the caller falls back
import { audioContext } from "./speech";
import { speedMark } from "./speed";
import type { Heard } from "./listen";

const RATE = 16000;
const CHUNK = 1600; // 100 ms of audio per message
const END_SILENCE_S = 0.7; // this much quiet after speech ends the utterance (measured: text ~2 s after)
const NO_SPEECH_MS = 7000; // nothing said at all -> "not heard"
const MAX_MS = 15000;
const CONNECT_MS = 5000; // no session by then -> give up (the caller may fall back)
const MIC_WAIT_MS = 20000; // the first time the phone asks permission; the rider (or a helper) answers
const FINAL_MS = 3000; // after EndOfStream, wait this long for the last words
const BUSY_RETRIES = 2;
const TOKEN_FRESH_MS = 40000; // keys live 60 s

interface Token {
  jwt: string;
  url: string;
  at: number;
}

let tokenPromise: Promise<Token | null> | null = null;

function fetchToken(): Promise<Token | null> {
  return fetch("/api/stt/token", { method: "POST" })
    .then(function (res) {
      return res.ok ? (res.json() as Promise<{ jwt: string; url: string }>) : null;
    })
    .then(function (body) {
      return body ? { jwt: body.jwt, url: body.url, at: Date.now() } : null;
    })
    .catch(function () {
      return null;
    });
}

// A key fetched ahead, so speaking never waits for it. Call when a screen where the rider may speak opens.
export function warmSpeech(): void {
  getToken();
}

function getToken(): Promise<Token | null> {
  const cached = tokenPromise;
  if (cached) {
    return cached.then(function (t) {
      if (t && Date.now() - t.at < TOKEN_FRESH_MS) {
        return t;
      }
      tokenPromise = fetchToken();
      return tokenPromise;
    });
  }
  tokenPromise = fetchToken();
  return tokenPromise;
}

// ---- Microphone -> 16 kHz 16-bit chunks ----

interface Mic {
  close: () => void;
}

type AudioSession = { type: string };
function audioSession(): AudioSession | undefined {
  return (navigator as Navigator & { audioSession?: AudioSession }).audioSession;
}

// Streaming linear resampler (the phone's rate, usually 48 kHz, -> 16 kHz).
function resampler(from: number): (input: Float32Array) => Float32Array {
  const step = from / RATE;
  let pos = 1; // in [previous block's last sample, ...this block]
  let last = 0;
  return function (input) {
    const out: number[] = [];
    while (pos + 1 <= input.length) {
      const i = Math.floor(pos);
      const f = pos - i;
      const a = i === 0 ? last : input[i - 1];
      const b = input[i];
      out.push(a * (1 - f) + b * f);
      pos += step;
    }
    pos -= input.length;
    last = input[input.length - 1];
    return Float32Array.from(out);
  };
}

// AudioWorklet (audio thread) where it loads; otherwise ScriptProcessor (main thread, everywhere).
// Measured: in some Chrome setups addModule never settles, which used to leave the rider stuck on
// "Сонсож байна", so it gets 1 s.
const workletLoads = new WeakMap<BaseAudioContext, Promise<boolean>>();
function workletLoaded(ctx: AudioContext): Promise<boolean> {
  let loaded = workletLoads.get(ctx);
  if (!loaded) {
    const add = ctx.audioWorklet
      ? ctx.audioWorklet.addModule("/recorder-worklet.js").then(
          function () {
            return true;
          },
          function () {
            return false;
          },
        )
      : Promise.resolve(false);
    loaded = Promise.race([
      add,
      new Promise<boolean>(function (resolve) {
        setTimeout(function () {
          resolve(false);
        }, 1000);
      }),
    ]);
    workletLoads.set(ctx, loaded);
  }
  return loaded;
}

function wire(ctx: AudioContext, stream: MediaStream, onChunk: (pcm: ArrayBuffer) => void, onAudio: () => void): Promise<Mic> {
  return workletLoaded(ctx).then(function (worklet) {
    const source = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keeps the graph running without playing the microphone back
    mute.connect(ctx.destination);
    const down = resampler(ctx.sampleRate);
    let batch = new Int16Array(CHUNK);
    let fill = 0;
    function take(block: Float32Array): void {
      onAudio();
      const samples = down(block);
      for (let i = 0; i < samples.length; i++) {
        batch[fill++] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
        if (fill === CHUNK) {
          onChunk(batch.buffer);
          batch = new Int16Array(CHUNK);
          fill = 0;
        }
      }
    }
    let node: AudioWorkletNode | null = null;
    if (worklet) {
      try {
        node = new AudioWorkletNode(ctx, "recorder");
      } catch {
        node = null;
      }
    }
    if (node) {
      const n = node;
      n.port.onmessage = function (e: MessageEvent<Float32Array>) {
        take(e.data);
      };
      source.connect(n);
      n.connect(mute);
      return {
        close: function () {
          n.port.onmessage = null;
          source.disconnect();
          n.disconnect();
          mute.disconnect();
        },
      };
    }
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = function (e: AudioProcessingEvent) {
      take(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(sp);
    sp.connect(mute);
    return {
      close: function () {
        sp.onaudioprocess = null;
        source.disconnect();
        sp.disconnect();
        mute.disconnect();
      },
    };
  });
}

// Opens the microphone. The shared context is the one the rider's last touch unlocked (iPhone keeps
// a new one silent); if no audio comes through it (iPhone can switch rates when the microphone
// starts, e.g. with Bluetooth earphones), a fresh context is tried once.
async function openMic(onChunk: (pcm: ArrayBuffer) => void): Promise<Mic> {
  const session = audioSession();
  if (session) {
    session.type = "play-and-record";
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    if (session) {
      session.type = "playback";
    }
    throw e;
  }
  function stopTracks(): void {
    stream.getTracks().forEach(function (item) {
      item.stop();
    });
    if (session) {
      session.type = "playback";
    }
  }
  async function attempt(ctx: AudioContext | null): Promise<Mic | null> {
    if (!ctx) {
      return null;
    }
    if (ctx.state !== "running") {
      await Promise.race([ctx.resume().catch(function () {}), new Promise(function (r) { setTimeout(r, 300); })]);
    }
    let heard = false;
    const mic = await wire(ctx, stream, onChunk, function () {
      heard = true;
    });
    await new Promise(function (r) {
      setTimeout(r, 700);
    });
    if (heard) {
      return mic;
    }
    mic.close();
    return null;
  }
  let mic = await attempt(audioContext());
  if (!mic) {
    mic = await attempt(typeof AudioContext === "undefined" ? null : new AudioContext());
  }
  if (!mic) {
    stopTracks();
    throw new DOMException("no audio from the microphone", "NotReadableError");
  }
  const opened = mic;
  return {
    close: function () {
      opened.close();
      stopTracks();
    },
  };
}

// ---- One utterance ----

interface ServerMessage {
  message: string;
  metadata?: { transcript: string };
  type?: string;
  reason?: string;
}

export function listenWithSpeechmatics(onWords?: (text: string) => void): { done: Promise<Heard>; stop: () => void } {
  let endRequest: () => void = function () {};
  let stopEarly = false;
  const done = new Promise<Heard>(function (resolve) {
    let finished = false;
    let ws: WebSocket | null = null;
    let mic: Mic | null = null;
    let started = false; // RecognitionStarted
    let ending = false; // EndOfStream sent (or will be, once started)
    let seq = 0;
    let busyTries = 0;
    let pending: ArrayBuffer[] = []; // audio from before the session started
    const finals: string[] = [];
    let partial = "";
    let spoke = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    function text(): string {
      return finals.join(" ").replace(/\s+([.,?!])/g, "$1").replace(/\s+/g, " ").trim();
    }
    function finish(result: Heard): void {
      if (finished) {
        return;
      }
      finished = true;
      timers.forEach(clearTimeout);
      if (mic) {
        mic.close();
        mic = null;
      }
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // already closed
        }
      }
      resolve(result);
    }
    function heardResult(): Heard {
      const t = text() || partial.trim();
      return t ? { text: t, error: "", code: "" } : { text: "", error: "not-heard", code: "no-speech" };
    }
    function failed(code: string): void {
      // Words already recognised still count; otherwise the caller may fall back.
      finish(text() ? heardResult() : { text: "", error: "network", code });
    }
    function sendEnd(): void {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ message: "EndOfStream", last_seq_no: seq }));
        timers.push(
          setTimeout(function () {
            finish(heardResult());
          }, FINAL_MS),
        );
      }
    }
    // The rider is done (silence, release, or a limit): microphone off now, last words still come.
    function end(): void {
      if (ending || finished) {
        return;
      }
      ending = true;
      if (mic) {
        mic.close();
        mic = null;
      }
      if (started) {
        sendEnd();
      } else if (pending.length === 0) {
        finish(heardResult()); // nothing was recorded yet
      }
      // else: the session is still starting; it sends the recorded audio, then EndOfStream
    }
    endRequest = end;

    function send(pcm: ArrayBuffer): void {
      if (ws && started && ws.readyState === WebSocket.OPEN) {
        ws.send(pcm);
        seq++;
      } else {
        pending.push(pcm);
      }
    }

    function connect(token: Token): void {
      timers.push(
        setTimeout(function () {
          if (!started) {
            failed("speechmatics:connect-timeout");
          }
        }, CONNECT_MS),
      );
      const socket = new WebSocket(token.url + "?jwt=" + encodeURIComponent(token.jwt));
      ws = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = function () {
        socket.send(
          JSON.stringify({
            message: "StartRecognition",
            audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: RATE },
            transcription_config: {
              language: "mn",
              model: "enhanced",
              max_delay: 0.7,
              enable_partials: true,
              conversation_config: { end_of_utterance_silence_trigger: END_SILENCE_S },
            },
          }),
        );
      };
      socket.onmessage = function (ev: MessageEvent<string>) {
        const m = JSON.parse(ev.data) as ServerMessage;
        if (m.message === "RecognitionStarted") {
          started = true;
          speedMark("listening");
          const waiting = pending;
          pending = [];
          waiting.forEach(function (item) {
            socket.send(item);
            seq++;
          });
          if (ending) {
            sendEnd();
          }
        } else if (m.message === "AddPartialTranscript" && m.metadata) {
          partial = m.metadata.transcript;
          if (partial.trim()) {
            spoke = true;
            if (onWords) {
              onWords((text() + " " + partial).trim());
            }
          }
        } else if (m.message === "AddTranscript" && m.metadata) {
          const t = m.metadata.transcript.trim();
          partial = "";
          if (t) {
            spoke = true;
            finals.push(t);
            if (onWords) {
              onWords(text());
            }
          }
        } else if (m.message === "EndOfUtterance") {
          if (spoke) {
            speedMark("speech end");
            end();
          }
        } else if (m.message === "EndOfTranscript") {
          speedMark("text");
          finish(heardResult());
        } else if (m.message === "Error") {
          // Busy (2 sessions at a time on the free account): the audio keeps coming in, try again shortly.
          if (m.type === "quota_exceeded" && !started && busyTries < BUSY_RETRIES) {
            busyTries++;
            socket.onclose = null;
            socket.onerror = null;
            timers.push(
              setTimeout(function () {
                if (!finished) {
                  connect(token);
                }
              }, 1000 * busyTries),
            );
            return;
          }
          failed("speechmatics:" + (m.type ?? "error"));
        }
      };
      socket.onerror = function () {
        failed("speechmatics:connection");
      };
      socket.onclose = function () {
        if (!finished) {
          failed("speechmatics:closed");
        }
      };
    }

    // Never stuck on "listening": the permission box left open, or a microphone that never opens.
    timers.push(
      setTimeout(function () {
        if (!mic && !ending) {
          finish({ text: "", error: "no-mic", code: "mic-timeout" });
        }
      }, MIC_WAIT_MS),
      setTimeout(function () {
        finish(heardResult());
      }, MAX_MS + MIC_WAIT_MS + FINAL_MS),
    );
    // Key fetched while the microphone opens (usually it's ready already: warmSpeech). The session
    // opens only once the microphone is on, so a permission box left open or a refused microphone
    // never holds one of the account's 2 sessions; what's said meanwhile is kept and sent first.
    const tokenNow = getToken();
    openMic(send).then(
      function (opened) {
        if (finished || ending) {
          opened.close();
          if (!finished) {
            finish(heardResult());
          }
          return;
        }
        mic = opened;
        timers.push(
          setTimeout(function () {
            if (!spoke) {
              end();
            }
          }, NO_SPEECH_MS),
          setTimeout(end, MAX_MS),
        );
        tokenNow.then(function (token) {
          if (finished) {
            return;
          }
          if (!token) {
            failed("speechmatics:no-key");
            return;
          }
          connect(token);
          if (stopEarly) {
            end();
          }
        });
      },
      function (e: unknown) {
        finish({ text: "", error: "no-mic", code: e instanceof Error || e instanceof DOMException ? e.name : "mic" });
      },
    );
  });
  return {
    done,
    stop: function () {
      stopEarly = true;
      endRequest();
    },
  };
}
