// Book reader from home and back: the fixture page as the camera, the page text from the mocked server
// OCR (Gemini), read in the mocked reader voice.
import { BUS, READ, homeButton, openHome } from "./app";
import { PAGE_LINES, expect, expectBack, phrase, test } from "./fixtures";

test.use({ camera: "page" });

test("reader: page photo -> OCR -> reading; back -> home", async function ({ page, paidCalls }) {
  await openHome(page);
  await homeButton(page, READ).click();
  await expect(page).toHaveURL(/\/read/);
  const capture = page.getByRole("button", { name: phrase("read_btn_capture"), exact: true });
  await expect(capture).toBeVisible();
  await expectBack(page, "reader: aiming");
  await expect
    .poll(function () {
      return page.locator("video").first().evaluate(function (item: HTMLVideoElement) {
        return item.videoWidth;
      });
    })
    .toBeGreaterThan(0);
  // The reader may already have taken the photo by itself (page in view and sharp)
  await capture.click({ timeout: 15_000 }).catch(function () {});
  await expect(page.locator(".reader-text")).toContainText(PAGE_LINES[0]);
  expect(paidCalls).toContain("reader/ocr");
  await expectBack(page, "reader: reading");
  await page.getByRole("button", { name: phrase("read_btn_back"), exact: true }).click();
  await expect(homeButton(page, BUS)).toBeVisible();
  await expect(homeButton(page, READ)).toBeVisible();
});
