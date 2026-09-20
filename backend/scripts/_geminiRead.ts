import { chromium } from "playwright-core";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 90000 });
  const context = browser.contexts()[0]!;
  const page = context.pages().find((p) => p.url().includes("gemini.google.com"))!;

  let lastLen = -1;
  let stableCount = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(3000);
    const text = await page.innerText("body");
    if (text.length === lastLen) {
      stableCount++;
      if (stableCount >= 3) break;
    } else {
      stableCount = 0;
    }
    lastLen = text.length;
  }

  console.log("=== FULL VISIBLE TEXT ===");
  console.log(await page.innerText("body"));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
