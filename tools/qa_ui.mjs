/**
 * Developer-only browser smoke test for a running ONNXTTS server.
 *
 * Prerequisite: start the app on http://127.0.0.1:4317. The script uses the
 * Codex-bundled Playwright package and local Edge, writes screenshots to qa/,
 * then prints a compact JSON report for manual or automated review.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

// Playwright is a development dependency supplied by the Codex runtime; it is
// deliberately not added to this dependency-free application's package.json.
const require = createRequire(import.meta.url);
const { chromium } = require("C:\\Users\\victorzzt\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright");

// Keep visual artifacts inside the repository's existing QA directory.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "qa");
await mkdir(output, { recursive: true });

// Use the same Windows browser available to local users, but without a window.
const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

// Browser console and uncaught page errors are included in the final report.
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

// Wait for models instead of trusting the initial HTML skeleton.
await page.goto("http://127.0.0.1:4317", { waitUntil: "networkidle" });
await page.locator(".voice-card").first().waitFor();
await page.screenshot({ path: path.join(output, "onnxtts-home.png"), fullPage: true });

// Exercise the real local synthesis path and wait for an audio URL.
await page.locator("#generate").click();
await page.locator("#result").waitFor({ state: "visible", timeout: 30_000 });
await page.waitForFunction(() => document.querySelector("#audio")?.getAttribute("src"));
const generatedAudio = await page.locator("#audio").getAttribute("src");

// The installer is now reached through the voice-library plus-menu.
await page.locator("#toggleAddMenu").click();
await page.locator("#openDownload").click();
await page.locator("#downloadDialog").waitFor({ state: "visible" });
await page.screenshot({ path: path.join(output, "onnxtts-installer.png"), fullPage: true });

// Emit machine-readable evidence after all UI assertions have passed.
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