import { chromium } from "playwright-core";

const QUESTION = process.argv[2];
if (!QUESTION) {
  console.error("usage: npx tsx scripts/_geminiAsk.ts \"<question>\"");
  process.exit(1);
}

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 90000 });
  const context = browser.contexts()[0]!;
  const page = context.pages().find((p) => p.url().includes("gemini.google.com"))!;
  await page.bringToFront();

  const textarea = page.getByRole("textbox").first();
  await textarea.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  try {
    await textarea.click({ timeout: 10000 });
  } catch {
    await textarea.click({ timeout: 10000, force: true });
  }
  await textarea.fill(QUESTION);
  await page.waitForTimeout(300);
  await textarea.press("Enter");

  console.log("sent, waiting for response...");
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

  console.log("=== FULL VISIBLE TEXT AFTER RESPONSE ===");
  console.log(await page.innerText("body"));

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
