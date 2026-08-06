import { describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { findPage } from "../src/browserWatch/cdpClient.js";

function fakePage(url: string, text: string): Page {
  return { url: () => url, on: () => {}, evaluate: async () => text } as unknown as Page;
}

/** A page whose evaluate() throws `failCount` times before succeeding -- simulates the transient contention race between two simultaneous findPage callers. */
function flakyPage(url: string, text: string, failCount: number): Page {
  let calls = 0;
  return {
    url: () => url,
    on: () => {},
    evaluate: async () => {
      calls++;
      if (calls <= failCount) throw new Error("simulated transient CDP contention");
      return text;
    },
  } as unknown as Page;
}

function fakeBrowser(pages: Array<{ url: string; text: string }>): Browser {
  return {
    contexts: () => [{ pages: () => pages.map((p) => fakePage(p.url, p.text)) }],
  } as unknown as Browser;
}

const AUTHENTICATED_TEXT = "Chart\nOrder\nBAL: $50,000.00\nMLL: $-2,000.00\nNo Active Position";
const LOGIN_TEXT = "Sign In\nEmail\nPassword\nForgot password?";

describe("findPage", () => {
  it("returns a matching tab whose content shows it's authenticated (real balance panel present)", async () => {
    const browser = fakeBrowser([{ url: "https://topstepx.com/trade", text: AUTHENTICATED_TEXT }]);
    const page = await findPage(browser, "topstepx.com");
    expect(page?.url()).toBe("https://topstepx.com/trade");
  });

  it("returns the authenticated tab even when its URL never actually reflects a trade-view path", async () => {
    // 2026-07-28 incident: TopstepX's client-side router doesn't update the
    // visible URL at all in some flows -- a fully logged-in, fully live
    // session with real balance/order-ticket content sat at the bare root
    // URL indefinitely. URL path turned out to be an unreliable signal;
    // content is what actually distinguishes the real page.
    const browser = fakeBrowser([{ url: "https://topstepx.com/", text: AUTHENTICATED_TEXT }]);
    const page = await findPage(browser, "topstepx.com");
    expect(page?.url()).toBe("https://topstepx.com/");
  });

  it("skips a matched tab sitting on the login page, even with no other match", async () => {
    // 2026-07-27 incident: this used to return the login tab (it matches
    // "topstepx.com" fine), feeding stray login-page text into price
    // extraction as if it were a real quote.
    const browser = fakeBrowser([{ url: "https://topstepx.com/login", text: LOGIN_TEXT }]);
    const page = await findPage(browser, "topstepx.com");
    expect(page).toBeNull();
  });

  it("prefers the authenticated tab over a login tab when both are open", async () => {
    const browser = fakeBrowser([
      { url: "https://topstepx.com/login", text: LOGIN_TEXT },
      { url: "https://topstepx.com/trade", text: AUTHENTICATED_TEXT },
    ]);
    const page = await findPage(browser, "topstepx.com");
    expect(page?.url()).toBe("https://topstepx.com/trade");
  });

  it("returns null when no tab matches at all", async () => {
    const browser = fakeBrowser([{ url: "https://example.com/", text: "unrelated" }]);
    const page = await findPage(browser, "topstepx.com");
    expect(page).toBeNull();
  });

  it("returns null when the only matching tab is a bare, not-yet-authenticated root page", async () => {
    const browser = fakeBrowser([{ url: "https://topstepx.com/", text: "Loading the Ultimate Trading Experience" }]);
    const page = await findPage(browser, "topstepx.com");
    expect(page).toBeNull();
  });

  it("retries a transient evaluate() failure instead of treating it as the wrong page", async () => {
    // 2026-07-28 incident: a live order placement's findPage call hit
    // "no_matching_tab_found" and got rejected, even though the exact same
    // tab served the price watcher fine moments before and after -- traced
    // to a race between two simultaneous findPage callers (the watcher's
    // poll loop and the order-placement call) hitting page.evaluate() on the
    // same page at once. One transient failure must not be treated the same
    // as a real login/wrong page.
    const page = flakyPage("https://topstepx.com/trade", AUTHENTICATED_TEXT, 2);
    const browser = { contexts: () => [{ pages: () => [page] }] } as unknown as Browser;
    const result = await findPage(browser, "topstepx.com");
    expect(result?.url()).toBe("https://topstepx.com/trade");
  });

  it("gives up on a candidate whose evaluate() never recovers, rather than hanging", async () => {
    const page = flakyPage("https://topstepx.com/trade", AUTHENTICATED_TEXT, 10); // never succeeds within the retry budget
    const browser = { contexts: () => [{ pages: () => [page] }] } as unknown as Browser;
    const result = await findPage(browser, "topstepx.com");
    expect(result).toBeNull();
  });
});
