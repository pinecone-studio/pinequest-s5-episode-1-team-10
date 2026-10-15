// No GPS (location refused): the rider is asked where they are, by voice or typing.
import { skipNumberIfAsked, startBus } from "./app";
import { expect, expectBack, phrase, test } from "./fixtures";

test.use({ permissions: [] });

test("no GPS: asks where the rider is", async function ({ page }) {
  // Refused in both browsers, the same way a phone reports it
  await page.addInitScript(function () {
    navigator.geolocation.getCurrentPosition = function (ok, fail) {
      if (fail) {
        fail({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
      }
    };
  });
  await startBus(page);
  await skipNumberIfAsked(page, function () {
    return expectBack(page, "family number");
  });
  await expect(page.getByRole("button", { name: phrase("menu_type_where"), exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: phrase("menu_say_where"), exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText(phrase("ask_location_sr"));
  await expectBack(page, "where are you");
});
