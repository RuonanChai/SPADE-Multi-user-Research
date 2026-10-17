import { chromium } from "playwright";
const URL = "http://localhost:8080/examples/hello-world/?_cb=" + Date.now();
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(URL, { waitUntil: "load", timeout: 15000 });
await page.waitForTimeout(6000);
const info = await page.evaluate(() => ({
  marks: window._marks,
}));
console.log(JSON.stringify(info, null, 2));
await browser.close();
