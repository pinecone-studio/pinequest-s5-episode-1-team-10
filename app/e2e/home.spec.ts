// Home: "Автобус" and "Ном унших", each within 2 swipes of the heading VoiceOver/TalkBack starts on.
import { BUS, READ, homeButton, openHome } from "./app";
import { expect, swipeOrder, test } from "./fixtures";

test("home: heading, then Автобус, then Ном унших", async function ({ page }) {
  await openHome(page);
  await expect(homeButton(page, READ)).toBeVisible();
  const order = await swipeOrder(page);
  expect(order[0], "the screen starts with its heading: " + order.join(" | ")).toMatch(/^heading /);
  expect(order.slice(1, 3), "the next two swipes: " + order.join(" | ")).toEqual(["button " + BUS, "button " + READ]);
});
