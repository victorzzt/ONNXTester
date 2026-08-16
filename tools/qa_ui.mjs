import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("C:\\Users\\victorzzt\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "qa");
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

await page.goto("http://127.0.0.1:4317", { waitUntil: "networkidle" });
await page.locator(".voice-card").first().waitFor();
await page.screenshot({ path: path.join(output, "onnxtts-home.png"), fullPage: true });

await page.locator("#generate").click();
await page.locator("#result").waitFor({ state: "visible", timeout: 30_000 });
await page.waitForFunction(() => document.querySelector("#audio")?.getAttribute("src"));
const generatedAudio = await page.locator("#audio").getAttribute("src");

await page.locator("#openDownloadWide").click();
await page.locator("#downloadDialog").waitFor({ state: "visible" });
await page.screenshot({ path: path.join(output, "onnxtts-installer.png"), fullPage: true });

const report = {
  title: await page.title(),
  voices: await page.locator(".voice-card").count(),
  selectedVoice: await page.locator(".voice-card.selected .voice-info b").textContent(),
  generatedAudio,
  dialogOpen: await page.locator("#downloadDialog").evaluate((node) => node.open),
  errors,
};
console.log(JSON.stringify(report, null, 2));
await browser.close();
