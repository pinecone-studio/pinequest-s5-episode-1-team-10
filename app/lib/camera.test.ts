import assert from "node:assert/strict";
import test from "node:test";
import { badForReading, fovForZoom, mainBackStream, openBusCamera, pickMainBack, pickUltraWide, wideZoom, type CameraDevice } from "./camera.ts";
import { MAIN_FOV_DEG, ULTRA_WIDE_FOV_DEG } from "./door.ts";

function list(labels: string[]): CameraDevice[] {
  return labels
    .map(function (item, i) {
      return { kind: "videoinput", label: item, deviceId: "cam" + i };
    })
    .concat([{ kind: "audioinput", label: "iPhone Microphone", deviceId: "mic" }]);
}

const iphonePro = list(["Back Dual Wide Camera", "Back Triple Camera", "Back Camera", "Back Ultra Wide Camera", "Back Telephoto Camera", "Back Dual Camera", "Front Camera"]);
const iphone = list(["Front Camera", "Back Camera", "Back Ultra Wide Camera", "Back Dual Wide Camera"]);
const iphoneOld = list(["Front Camera", "Back Camera"]);
const android = list(["camera2 1, facing front", "camera2 0, facing back", "camera2 2, facing back", "camera2 3, facing back"]);
const hidden = list(["", "", ""]); // before the camera is allowed
const russian = list(["Фронтальная камера", "Задняя камера", "Задняя сверхширокоугольная камера"]);
const laptop = list(["FaceTime HD Camera"]);

function label(device: CameraDevice | null): string | null {
  return device ? device.label : null;
}

test("the bus scanner picks the ultra-wide by its label", function () {
  assert.equal(label(pickUltraWide(iphonePro)), "Back Ultra Wide Camera");
  assert.equal(label(pickUltraWide(iphone)), "Back Ultra Wide Camera");
  assert.equal(label(pickUltraWide(list(["Back UltraWide Camera"]))), "Back UltraWide Camera");
});

test("no ultra-wide label: the bus scanner keeps the default camera", function () {
  assert.equal(pickUltraWide(iphoneOld), null);
  assert.equal(pickUltraWide(android), null);
  assert.equal(pickUltraWide(hidden), null);
  assert.equal(pickUltraWide(russian), null);
  assert.equal(pickUltraWide(laptop), null);
  assert.equal(pickUltraWide([]), null);
  assert.equal(pickUltraWide(list(["Front Ultra Wide Camera"])), null);
  assert.equal(pickUltraWide([{ kind: "audioinput", label: "Ultra Wide", deviceId: "x" }]), null);
});

test("the reader picks the main back camera, never a wide, tele or multi-lens one", function () {
  assert.equal(label(pickMainBack(iphonePro)), "Back Camera");
  assert.equal(label(pickMainBack(iphone)), "Back Camera");
  assert.equal(label(pickMainBack(iphoneOld)), "Back Camera");
  assert.equal(label(pickMainBack(android)), "camera2 0, facing back");
  assert.equal(label(pickMainBack(list(["Back Triple Camera", "Back Ultra Wide Camera"]))), null);
});

test("no back camera label: the reader keeps the browser's choice", function () {
  assert.equal(pickMainBack(hidden), null);
  assert.equal(pickMainBack(russian), null);
  assert.equal(pickMainBack(laptop), null);
  assert.equal(pickMainBack([]), null);
});

test("cameras that are bad for reading", function () {
  ["Back Ultra Wide Camera", "Back Telephoto Camera", "Back Dual Wide Camera", "Back Triple Camera", "Back Dual Camera", "Front Camera"].forEach(function (item) {
    assert.equal(badForReading(item), true, item);
  });
  ["Back Camera", "camera2 0, facing back", "", "FaceTime HD Camera"].forEach(function (item) {
    assert.equal(badForReading(item), false, item);
  });
});

test("Android zooms out to its ultra-wide when the zoom goes below 1", function () {
  assert.equal(wideZoom({ zoom: { min: 0.5 } }), 0.5);
  assert.equal(wideZoom({ zoom: { min: 0.6 } }), 0.6);
  assert.equal(wideZoom({ zoom: { min: 1 } }), null);
  assert.equal(wideZoom({ zoom: {} }), null);
  assert.equal(wideZoom({ zoom: { min: 0 } }), null);
  assert.equal(wideZoom({}), null);
  assert.equal(wideZoom(undefined), null);
  assert.equal(wideZoom(null), null);
});

test("the field of view of a zoomed-out main camera", function () {
  assert.equal(fovForZoom(1), MAIN_FOV_DEG);
  assert.equal(Math.round(fovForZoom(0.5)), 104);
});

// A fake camera API: getUserMedia opens the camera named by deviceId (or the default one).
interface Opened {
  constraints: MediaTrackConstraints;
  stopped: boolean;
}

function fakeTrack(name: string, minZoom: number | null, opened: Opened, applied: unknown[]) {
  return {
    label: name,
    stop: function () {
      opened.stopped = true;
    },
    getCapabilities: function () {
      return minZoom === null ? {} : { zoom: { min: minZoom, max: 8 } };
    },
    applyConstraints: async function (c: unknown) {
      applied.push(c);
    },
  };
}

function fakePhone(devices: CameraDevice[], defaultLabel: string, opts?: { minZoom?: number; failExact?: boolean; userAgent?: string }) {
  const calls: Opened[] = [];
  const applied: unknown[] = [];
  const mediaDevices = {
    enumerateDevices: async function () {
      return devices;
    },
    getUserMedia: async function (c: { video: MediaTrackConstraints }) {
      const exact = c.video.deviceId ? (c.video.deviceId as { exact: string }).exact : null;
      if (exact && opts && opts.failExact) {
        throw new Error("OverconstrainedError");
      }
      const found = devices.find(function (item) {
        return item.deviceId === exact;
      });
      const opened = { constraints: c.video, stopped: false };
      calls.push(opened);
      const track = fakeTrack(found ? found.label : defaultLabel, opts && opts.minZoom !== undefined ? opts.minZoom : null, opened, applied);
      return {
        getVideoTracks: function () {
          return [track];
        },
        getTracks: function () {
          return [track];
        },
      } as unknown as MediaStream;
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices, userAgent: (opts && opts.userAgent) || "iPhone" }, configurable: true, writable: true });
  return { calls, applied };
}

const size = { width: { ideal: 1280 }, height: { ideal: 720 } };

test("iPhone: the bus camera switches to the ultra-wide, after stopping the default one", async function () {
  const phone = fakePhone(iphonePro, "Back Camera");
  const got = await openBusCamera(size);
  assert.equal(got.choice, "ultrawide-label");
  assert.equal(got.label, "Back Ultra Wide Camera");
  assert.equal(got.fovDeg, ULTRA_WIDE_FOV_DEG);
  assert.equal(phone.calls.length, 2);
  assert.equal(phone.calls[0].stopped, true);
  assert.deepEqual(phone.calls[1].constraints, { ...size, deviceId: { exact: "cam3" } });
});

test("iPhone: the ultra-wide refuses to open, the default camera is opened again", async function () {
  const phone = fakePhone(iphonePro, "Back Camera", { failExact: true });
  const got = await openBusCamera(size);
  assert.equal(got.choice, "default");
  assert.equal(got.fovDeg, MAIN_FOV_DEG);
  assert.equal(got.label, "Back Camera");
  assert.equal(phone.calls.length, 2);
  assert.equal(phone.calls[1].stopped, false);
});

test("?cam=main keeps the default camera", async function () {
  const phone = fakePhone(iphonePro, "Back Camera", { minZoom: 0.5 });
  const got = await openBusCamera(size, true);
  assert.equal(got.choice, "default");
  assert.equal(got.fovDeg, MAIN_FOV_DEG);
  assert.equal(phone.calls.length, 1);
  assert.equal(phone.applied.length, 0);
});

test("Android: the bus camera zooms out below 1x", async function () {
  const phone = fakePhone(android, "camera2 0, facing back", { minZoom: 0.5, userAgent: "Linux; Android 14" });
  const got = await openBusCamera(size);
  assert.equal(got.choice, "ultrawide-zoom");
  assert.equal(Math.round(got.fovDeg), 104);
  assert.equal(phone.calls.length, 1);
  assert.equal((phone.calls[0].constraints as { zoom?: boolean }).zoom, true);
  assert.deepEqual(phone.applied, [{ advanced: [{ zoom: 0.5 }] }]);
});

test("Android without a zoom below 1x: the default camera", async function () {
  const phone = fakePhone(android, "camera2 0, facing back", { minZoom: 1, userAgent: "Linux; Android 14" });
  const got = await openBusCamera(size);
  assert.equal(got.choice, "default");
  assert.equal(phone.applied.length, 0);
});

test("the reader leaves iPhone's virtual Triple camera for the main one", async function () {
  const phone = fakePhone(iphonePro, "Back Triple Camera");
  const first = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  const got = await mainBackStream(first, size);
  assert.equal(got.label, "Back Camera");
  assert.equal(phone.calls[0].stopped, true);
  assert.deepEqual(phone.calls[1].constraints, { ...size, deviceId: { exact: "cam2" } });
});

test("the reader keeps a good default camera as it is", async function () {
  const phone = fakePhone(iphonePro, "Back Camera");
  const first = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  const got = await mainBackStream(first, size);
  assert.equal(got.stream, first);
  assert.equal(got.label, "Back Camera");
  assert.equal(phone.calls.length, 1);
});
