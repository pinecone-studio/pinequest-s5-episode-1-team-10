// Getting around the app the way a screen-reader rider does: plain buttons, by their spoken labels.
import type { Page } from "@playwright/test";
import { expect, phrase } from "./fixtures";

// Home (NIGHT_PLAN item 1): two big buttons. Their labels come from the plan, not from phrases.json.
export const BUS = "Автобус";
export const READ = "Ном унших";

export function homeButton(page: Page, name: string) {
  return page.getByRole("button", { name: name, exact: true });
}

// Opens home. If the app first asks how the phone is used, the screen-reader choice is taken: every
// screen is then plain buttons (components/SrScreen.tsx).
export async function openHome(page: Page, query: string = "?notutorial"): Promise<void> {
  await page.goto("/" + query);
  const bus = homeButton(page, BUS);
  const screenReader = page.getByRole("button", { name: /^Дэлгэц уншигчтай/ });
  await expect(bus.or(screenReader).first()).toBeVisible();
  if (await screenReader.isVisible()) {
    await screenReader.click();
  }
  await expect(bus).toBeVisible();
}

// Home -> the bus side, as the rider starts a journey.
export async function startBus(page: Page): Promise<void> {
  await openHome(page);
  await homeButton(page, BUS).click();
}

// The first-time family number question (SOS), if it comes: put off.
export async function skipNumberIfAsked(page: Page, onScreen: () => Promise<void>): Promise<void> {
  const later = page.getByRole("button", { name: phrase("menu_later"), exact: true });
  const place = page.getByRole("button", { name: phrase("menu_place_yes"), exact: true });
  const where = page.getByRole("button", { name: phrase("menu_type_where"), exact: true });
  await expect(later.or(place).or(where).first()).toBeVisible();
  if (await later.isVisible()) {
    await onScreen();
    await later.click();
  }
}
