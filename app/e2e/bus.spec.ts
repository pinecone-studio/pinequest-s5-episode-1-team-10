// Bus journey with emulated GPS at Сүхбаатарын талбай: nearest stop -> destination -> plan (live bus
// data: /api/stops, /api/plan) -> camera on the bus photo (Pixel: Chromium's fake camera video; iPhone:
// the photo through getUserMedia). Every screen on the way needs a labelled back button.
import { skipNumberIfAsked, startBus } from "./app";
import { expect, expectBack, phrase, test } from "./fixtures";

const DESTINATION = "Сансар"; // Ч:29Б from this stop, 4 stops (server/test_lite.py plans the same name)

test("bus: GPS -> nearest stop -> plan -> camera", async function ({ page, paidCalls }) {
  await startBus(page);
  await skipNumberIfAsked(page, function () {
    return expectBack(page, "family number");
  });

  // Nearest stop, from GPS
  const placeYes = page.getByRole("button", { name: phrase("menu_place_yes"), exact: true });
  await expect(placeYes).toBeVisible();
  await expect(page.locator("main")).toContainText("Сүхбаатарын талбай");
  await expectBack(page, "your stop");
  await placeYes.click();

  // Destination, typed
  const type = page.getByRole("button", { name: phrase("menu_type_destination"), exact: true });
  await expect(type).toBeVisible();
  await expectBack(page, "where to");
  await type.click();
  await page.getByLabel("Очих газар").fill(DESTINATION);
  await expectBack(page, "typing the destination");
  await page.getByRole("button", { name: phrase("menu_done"), exact: true }).click();

  // The plan (a "did you mean" first if the server isn't sure)
  const camera = page.getByRole("button", { name: phrase("menu_open_camera"), exact: true });
  const yes = page.getByRole("button", { name: phrase("menu_yes_correct"), exact: true });
  await expect(camera.or(yes).first()).toBeVisible();
  if (await yes.isVisible()) {
    await expectBack(page, "did you mean");
    await yes.click();
  }
  await expect(camera).toBeVisible();
  await expect(page.locator("main")).toContainText("Ч:29Б");
  await expectBack(page, "the plan");
  await camera.click();

  // The camera, on the bus photo
  await expect
    .poll(function () {
      return page.locator("video").first().evaluate(function (item: HTMLVideoElement) {
        return item.videoWidth;
      });
    })
    .toBeGreaterThan(0);
  await expectBack(page, "the camera");
  await page.waitForTimeout(8000); // the detector and sign reader run on a few frames
  expect(
    paidCalls.filter(function (item) {
      return item === "read-sign";
    }),
    "the default camera reads signs on the phone, not with Azure",
  ).toEqual([]);
  await page.getByRole("button", { name: phrase("menu_back"), exact: true }).first().click();
  await expect(camera).toBeVisible();
});
