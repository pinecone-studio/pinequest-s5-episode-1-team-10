// Aiming the camera without seeing: the back camera, what to tell the rider about each frame, and
// the full-resolution photo once the page is in view.
import type { FrameCheck } from "./protocol";
import { mainBackStream } from "../camera";

export type Advice = "noText" | "dark" | "back" | "closer" | "left" | "right" | "up" | "down" | "still" | "ready";

const MAX_PHOTO = 3000; // longest side handed to the reader (measured: enough for newspaper print)

// What to say about one frame. `sharpest`: the sharpest recent frame (blur is judged relative to it,
// since sharpness depends on the page as much as on focus). `minLine`: smallest readable line height
// (fraction of the frame) for this camera's photos (Camera.minLine).
export function advise(check: FrameCheck, sharpest: number, minLine: number): Advice {
  if (check.lines < 2) {
    return check.brightness < 0.22 ? "dark" : "noText";
  }
  const cut = check.cut;
  const edges = [cut.left, cut.right, cut.top, cut.bottom].filter(Boolean).length;
  if (edges >= 3 || (cut.left && cut.right) || (cut.top && cut.bottom)) {
    return "back";
  }
  if (cut.left) {
    return "left";
  }
  if (cut.right) {
    return "right";
  }
  if (cut.top) {
    return "up";
  }
  if (cut.bottom) {
    return "down";
  }
  if (check.lineHeight < minLine) {
    return "closer";
  }
  if (sharpest > 0 && check.sharpness < 0.35 * sharpest) {
    return "still";
  }
  return "ready";
}

// 0..1, for the aiming tick's pitch: how close the frame is to being ready.
export function quality(check: FrameCheck, advice: Advice): number {
  if (advice === "ready") {
    return 1;
  }
  if (advice === "noText" || advice === "dark") {
    return 0;
  }
  const area = (check.box[2] - check.box[0]) * (check.box[3] - check.box[1]);
  return Math.min(0.85, 0.3 + area);
}

export interface Camera {
  // The page swaps its <video> element when the screen changes (start -> aiming): the stream follows.
  attach: (video: HTMLVideoElement) => void;
  torch: boolean; // the phone has a light we can turn on
  // Smallest line (detected height / frame height) that still reads well in this camera's photos:
  // measured 99.3% on a page with 0.0046 in a 3000 px photo (~14 px); a video frame (1920 px) needs more.
  minLine: number;
  frame: (maxSide: number) => Promise<ImageBitmap | null>;
  photo: () => Promise<ImageBitmap | null>;
  light: (on: boolean) => Promise<void>;
  stop: () => void;
}

// ?image=/test/read/page.jpg shows a still photo as if the camera were pointed at it (testing).
function imageStream(url: string): Promise<{ stream: MediaStream; img: HTMLImageElement }> {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement("canvas");
      const s = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.round(img.naturalWidth * s);
      canvas.height = Math.round(img.naturalHeight * s);
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      const stream = canvas.captureStream(10);
      const track = stream.getVideoTracks()[0];
      const timer = setInterval(function () {
        if (track.readyState === "ended") {
          clearInterval(timer);
        } else {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }
      }, 100);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ stream, img });
    };
    img.onerror = reject;
    img.src = url;
  });
}

function fit(w: number, h: number, maxSide: number): { w: number; h: number } {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

async function bitmapOf(source: HTMLVideoElement | HTMLImageElement | Blob, w: number, h: number, maxSide: number): Promise<ImageBitmap> {
  const size = fit(w, h, maxSide);
  try {
    return await createImageBitmap(source, { resizeWidth: size.w, resizeHeight: size.h, resizeQuality: "high" });
  } catch {
    // older Safari: no resize options
    const c = document.createElement("canvas");
    c.width = size.w;
    c.height = size.h;
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    if (source instanceof Blob) {
      const full = await createImageBitmap(source);
      ctx.drawImage(full, 0, 0, size.w, size.h);
      full.close();
    } else {
      ctx.drawImage(source, 0, 0, size.w, size.h);
    }
    return createImageBitmap(c);
  }
}

interface PhotoRange {
  max: number;
}

interface PhotoCapture {
  takePhoto: (settings?: { imageWidth?: number; imageHeight?: number; fillLightMode?: string }) => Promise<Blob>;
  getPhotoCapabilities?: () => Promise<{ imageWidth?: PhotoRange; imageHeight?: PhotoRange; fillLightMode?: string[] }>;
}

// The box shows the whole picture at its real shape (CSS: object-fit contain), whatever size the
// camera gave: upright on a phone, wide on a laptop or a phone turned sideways.
function fitBox(video: HTMLVideoElement): void {
  if (video.videoWidth && video.videoHeight) {
    video.style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
  }
}

// Starts a video element showing the stream. Safari never settles play() on an element that was taken
// off the page meanwhile, so waiting is limited, and a refusal (not allowed to autoplay) is not fatal.
async function startVideo(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.onloadedmetadata = function () {
    fitBox(video);
  };
  video.onresize = function () {
    fitBox(video); // the phone was turned
  };
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  await Promise.race([
    video.play().catch(function () {}),
    new Promise<void>(function (resolve) {
      setTimeout(resolve, 2500);
    }),
  ]);
}

export async function openCamera(first: HTMLVideoElement): Promise<Camera> {
  let video = first;
  const test = new URLSearchParams(window.location.search).get("image");
  let stream: MediaStream;
  let still: HTMLImageElement | null = null;
  if (test) {
    const t = await imageStream(test);
    stream = t.stream;
    still = t.img;
  } else {
    // A page needs detail. Where the phone can take a real photo (ImageCapture, Android Chrome) the
    // photo is full size and 1080p video is enough for aiming. Safari can't, so the page photo is a
    // video frame: ask for 4K there (a 1080p frame lost small print), else the best the phone gives.
    // Upright (9:16), like the phone and a book page (user: the wide 16:9 view wasted the sides).
    const canPhoto = "ImageCapture" in window;
    const hd = { width: { ideal: 1080 }, height: { ideal: 1920 } };
    let size: MediaTrackConstraints = canPhoto ? hd : { width: { ideal: 2160 }, height: { ideal: 3840 } };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: "environment" }, audio: false });
    } catch {
      size = hd;
      stream = await navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: "environment" }, audio: false });
    }
    // The main back camera, never the ultra-wide (distorts a page up close, focuses badly) nor
    // iPhone's virtual Dual/Triple camera (switches to the ultra-wide for close-ups).
    stream = (await mainBackStream(stream, size)).stream;
  }
  await startVideo(video, stream);
  const track = stream.getVideoTracks()[0];
  const caps = (track.getCapabilities ? track.getCapabilities() : {}) as MediaTrackCapabilities & { torch?: boolean };
  const ImageCaptureClass = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => PhotoCapture }).ImageCapture;
  const capture = !still && ImageCaptureClass ? new ImageCaptureClass(track) : null;
  // The largest photo the camera takes, without its flash (glare on paper). Asked once.
  const photoSettings = capture && capture.getPhotoCapabilities
    ? capture.getPhotoCapabilities().then(
        function (pc) {
          return {
            imageWidth: pc.imageWidth ? pc.imageWidth.max : undefined,
            imageHeight: pc.imageHeight ? pc.imageHeight.max : undefined,
            fillLightMode: pc.fillLightMode && pc.fillLightMode.indexOf("off") >= 0 ? "off" : undefined,
          };
        },
        function () {
          return {};
        },
      )
    : Promise.resolve({});
  let torchOn = false;
  return {
    attach: function (next: HTMLVideoElement) {
      if (next !== video) {
        video = next;
        startVideo(video, stream).catch(function () {});
      }
    },
    torch: Boolean(caps.torch),
    // smallest line height (share of the frame) that still reads well in the photo; asked each frame,
    // so it follows the video's real size once its metadata is in (before that: the stricter limit)
    get minLine() {
      return still || capture || Math.max(video.videoWidth, video.videoHeight) >= 3000 ? 0.003 : 0.0045;
    },
    frame: function (maxSide: number) {
      if (!video.videoWidth) {
        return Promise.resolve(null);
      }
      return bitmapOf(video, video.videoWidth, video.videoHeight, maxSide).catch(function () {
        return null;
      });
    },
    photo: async function () {
      if (still) {
        return bitmapOf(still, still.naturalWidth, still.naturalHeight, MAX_PHOTO);
      }
      if (capture) {
        try {
          const settings: { imageWidth?: number; imageHeight?: number; fillLightMode?: string } = { ...(await photoSettings) };
          if (torchOn) {
            delete settings.fillLightMode; // the rider's light stays as it is
          }
          let blob: Blob;
          try {
            blob = await capture.takePhoto(settings);
          } catch {
            blob = await capture.takePhoto(); // this phone refuses the settings
          }
          const full = await createImageBitmap(blob);
          const w = full.width;
          const h = full.height;
          full.close();
          // A photo in the sensor's orientation (sideways to the upright video) would be read
          // sideways: then the video frame is the safer page.
          const sideways = w !== h && video.videoWidth !== video.videoHeight && (w > h) !== (video.videoWidth > video.videoHeight);
          if (!sideways || !video.videoWidth) {
            return await bitmapOf(blob, w, h, MAX_PHOTO);
          }
          console.info("[camera] reader: photo " + w + "x" + h + " is sideways to the video " + video.videoWidth + "x" + video.videoHeight + ", using the video frame");
        } catch {
          // some phones refuse while streaming: use the video frame
        }
      }
      return video.videoWidth ? bitmapOf(video, video.videoWidth, video.videoHeight, MAX_PHOTO) : null;
    },
    light: async function (on: boolean) {
      if (!caps.torch) {
        return;
      }
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
        torchOn = on;
      } catch {
        // not allowed on this phone
      }
    },
    stop: function () {
      stream.getTracks().forEach(function (item) {
        item.stop();
      });
      video.style.aspectRatio = "";
      video.srcObject = null;
      first.srcObject = null;
    },
  };
}
