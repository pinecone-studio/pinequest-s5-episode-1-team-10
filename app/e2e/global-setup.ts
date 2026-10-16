// A protected Vercel Preview: one visit with the project's "Protection Bypass for Automation" secret sets
// the bypass cookie, saved for every test (playwright.config.ts storageState). SameSite=None, so the
// cookie also goes with the app's own cross-site-initiated requests. The secret is never printed: a
// failed visit is reported without its URL.
import { chromium, type FullConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";

const AUTH_STATE = "e2e/.auth/state.json";

export default async function globalSetup(config: FullConfig): Promise<void> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) {
    return;
  }
  const baseURL = config.projects[0].use.baseURL ?? process.env.BASE_URL;
  if (!baseURL) {
    throw new Error("VERCEL_AUTOMATION_BYPASS_SECRET is set but BASE_URL is not");
  }
  mkdirSync("e2e/.auth", { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = new URL("/", baseURL);
    url.searchParams.set("x-vercel-protection-bypass", secret);
    url.searchParams.set("x-vercel-set-bypass-cookie", "samesitenone");
    let status = 0;
    try {
      const res = await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      status = res ? res.status() : 0;
    } catch (e) {
      throw new Error("bypass visit to " + baseURL + " failed: " + (e instanceof Error ? e.name : "error"));
    }
    if (status >= 400) {
      throw new Error("bypass visit to " + baseURL + " answered " + status + " (wrong or revoked secret?)");
    }
    await context.storageState({ path: AUTH_STATE });
  } finally {
    await browser.close();
  }
}
