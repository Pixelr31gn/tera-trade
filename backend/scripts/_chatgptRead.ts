import { chromium } from "playwright-core";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 90000 });
  const context = browser.contexts()[0]!;
  const page = context.pages().find((p) => p.url().includes("chatgpt.com/c/"))!;
  await page.bringToFront();
  await page.waitForTimeout(1500);

  console.log("=== FULL VISIBLE TEXT ===");
  console.log(await page.innerText("body"));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
