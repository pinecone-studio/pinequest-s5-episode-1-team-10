"use client";

// /debug/ocr-bench: on-device sign OCR (lib/localSignOcr.ts) vs Azure (/api/read-sign) on the photos in
// public/test-fixtures/bus (labels.json: the stop, and each photo's route read by eye; null = no
// readable number). Each photo goes through the LED cropper (lib/crop-led.ts) like the camera; both
// readers read the same crops; the texts go through the same matcher (lib/signMatch.ts) with the routes
// near the stop. Per reader: right "yes" for the photo's route, wrong "yes" for any other route, p50 ms.
// The photos are local only (bystanders): gitignored and not deployed.
import { useEffect, useRef, useState } from "react";
import { candidatesNear, loadRouteData } from "../lib/candidates";
import { ledCropsOf } from "../lib/crop-led";
import { loadLocalOcr, localOcrReady, localOcrState, readLocal } from "../lib/localSignOcr";
import { matchSign } from "../lib/signMatch";

const FIXTURES = "/test-fixtures/bus/";
const AZURE_GAP_MS = 3200; // Azure free tier: 20 calls a minute

interface Labels {
  stop: { name: string; lat: number; lng: number };
  photos: Record<string, string | null>;
}

interface Side {
  text: string;
  ms: number | null; // p50 of this photo's crops; null: not read
  yesFor: string[];
}

interface Row {
  photo: string;
  truth: string | null;
  crops: number;
  images: string[]; // the crops as sent, to see what the cropper cut
  local: Side;
  azure: Side;
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function median(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  const s = values.slice().sort(function (a, b) {
    return a - b;
  });
  return s[Math.floor(s.length / 2)];
}

function gray(from: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = from.width;
  c.height = from.height;
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(from, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    d[i] = y;
    d[i + 1] = y;
    d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () {
      resolve(img);
    };
    img.onerror = reject;
    img.src = src;
  });
}

async function azureRead(canvas: HTMLCanvasElement): Promise<{ lines: string[]; ms: number } | null> {
  const blob = await new Promise<Blob | null>(function (resolve) {
    canvas.toBlob(resolve, "image/jpeg", 0.75);
  });
  if (!blob) {
    return null;
  }
  for (let tries = 0; tries < 4; tries++) {
    const t = performance.now();
    const res = await fetch("/api/read-sign", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    if (res.status === 429) {
      await sleep((parseFloat(res.headers.get("retry-after") ?? "") || 10) * 1000);
      continue;
    }
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { lines: string[] };
    return { lines: body.lines, ms: Math.round(performance.now() - t) };
  }
  return null;
}

export default function OcrBench() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("starting");
  const started = useRef(false);

  useEffect(function () {
    if (started.current) {
      return;
    }
    started.current = true;
    (async function () {
      const res = await fetch(FIXTURES + "labels.json");
      if (!res.ok) {
        setStatus("No fixtures: put photos and labels.json in public/test-fixtures/bus (local only).");
        return;
      }
      const labels = (await res.json()) as Labels;
      await loadRouteData();
      loadLocalOcr();
      for (let i = 0; i < 120 && !localOcrReady() && localOcrState() !== "off"; i++) {
        setStatus("loading the on-device model: " + localOcrState());
        await sleep(500);
      }
      const pool = candidatesNear("", { lat: labels.stop.lat, lng: labels.stop.lng });
      if (!pool || !pool.near) {
        setStatus("no route data for the stop");
        return;
      }
      const near = pool.near;
      const all = pool.all;
      const yesFor = function (text: string): string[] {
        return near
          .filter(function (item) {
            return matchSign(text, item.key, near, all).verdict === "yes";
          })
          .map(function (item) {
            return item.key;
          });
      };
      const names = Object.keys(labels.photos);
      const out: Row[] = [];
      for (let n = 0; n < names.length; n++) {
        const photo = names[n];
        setStatus("photo " + (n + 1) + " / " + names.length + " (local " + localOcrState() + ")");
        const img = await loadImage(FIXTURES + photo);
        const crops = ledCropsOf(img).map(function (item) {
          return gray(item.canvas);
        });
        const localTexts: string[] = [];
        const localMs: number[] = [];
        const azureTexts: string[] = [];
        const azureMs: number[] = [];
        for (let k = 0; k < crops.length; k++) {
          const t = performance.now();
          const local = await readLocal(crops[k]);
          if (local) {
            localMs.push(Math.round(performance.now() - t));
            localTexts.push(local.text);
          }
          const azure = await azureRead(crops[k]);
          if (azure) {
            azureMs.push(azure.ms);
            azureTexts.push(azure.lines.join(" "));
          }
          await sleep(AZURE_GAP_MS);
        }
        const localText = localTexts.join(" | ");
        const azureText = azureTexts.join(" | ");
        out.push({
          photo,
          truth: labels.photos[photo],
          crops: crops.length,
          images: crops.map(function (item) {
            return item.toDataURL("image/jpeg", 0.6);
          }),
          local: { text: localText, ms: median(localMs), yesFor: yesFor(localText.replace(/\|/g, " ")) },
          azure: { text: azureText, ms: median(azureMs), yesFor: yesFor(azureText.replace(/\|/g, " ")) },
        });
        setRows(out.slice());
      }
      setStatus("done");
      (window as unknown as { __bench: Row[] }).__bench = out;
    })();
  }, []);

  function summary(side: "local" | "azure"): string {
    const labelled = rows.filter(function (item) {
      return item.truth;
    });
    const right = labelled.filter(function (item) {
      return item[side].yesFor.indexOf(item.truth as string) >= 0;
    }).length;
    const wrong = rows.reduce(function (sum, item) {
      return (
        sum +
        item[side].yesFor.filter(function (k) {
          return k !== item.truth;
        }).length
      );
    }, 0);
    const ms = median(
      rows
        .map(function (item) {
          return item[side].ms;
        })
        .filter(function (item): item is number {
          return item !== null;
        }),
    );
    return "right yes " + right + "/" + labelled.length + " · wrong yes " + wrong + " · p50 " + (ms ?? "-") + " ms";
  }

  return (
    <main className="flow" style={{ maxWidth: "none" }}>
      <h1 className="title">OCR bench</h1>
      <p className="status" id="bench-status">
        {status} · on-device: {localOcrState()}
      </p>
      <p id="bench-summary">
        <b>On-device:</b> {summary("local")}
        <br />
        <b>Azure:</b> {summary("azure")}
      </p>
      <table style={{ fontSize: "0.8rem", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>photo</th>
            <th>truth</th>
            <th>crops</th>
            <th>cut</th>
            <th>on-device text</th>
            <th>ms</th>
            <th>yes for</th>
            <th>Azure text</th>
            <th>ms</th>
            <th>yes for</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(function (item) {
            return (
              <tr key={item.photo}>
                <td>{item.photo}</td>
                <td>{item.truth ?? "—"}</td>
                <td>{item.crops}</td>
                <td>
                  {item.images.map(function (src, i) {
                    // eslint-disable-next-line @next/next/no-img-element
                    return <img key={i} src={src} alt="" style={{ maxHeight: 40, maxWidth: 200, display: "block" }} />;
                  })}
                </td>
                <td>{item.local.text}</td>
                <td>{item.local.ms ?? "-"}</td>
                <td>{item.local.yesFor.join(" ")}</td>
                <td>{item.azure.text}</td>
                <td>{item.azure.ms ?? "-"}</td>
                <td>{item.azure.yesFor.join(" ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
