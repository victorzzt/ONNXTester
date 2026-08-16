/**
 * Download one pinned runtime artifact with Node.js only.
 *
 * The Linux installer uses this helper so curl, wget, and a system Python are
 * not prerequisites. Existing downloads are reused only when their SHA-256
 * and optional minimum size still match.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";

function readOptions(argv) {
  const options = {};
  const usage = "Usage: download_runtime_asset.mjs (--url URL --output FILE --sha256 HASH [--minimum-bytes N] | --manifest FILE --output-directory DIR)";
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value == null) {
      throw new Error(usage);
    }
    options[name.slice(2)] = value;
  }

  if (options.manifest || options["output-directory"]) {
    if (!options.manifest || !options["output-directory"] || options.url || options.output || options.sha256) {
      throw new Error(usage);
    }
    return { mode: "manifest", manifest: options.manifest, outputDirectory: options["output-directory"] };
  }
  if (!options.url || !options.output || !/^[a-f0-9]{64}$/i.test(options.sha256 || "")) {
    throw new Error(usage);
  }
  const parsedUrl = new URL(options.url);
  if (parsedUrl.protocol !== "https:") throw new Error("Runtime artifacts must use HTTPS.");
  const minimumBytes = Number(options["minimum-bytes"] || 1);
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 1) {
    throw new Error("--minimum-bytes must be a positive integer.");
  }
  return { mode: "single", ...options, sha256: options.sha256.toLowerCase(), minimumBytes };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function reusable(filePath, expectedHash, minimumBytes) {
  if (!existsSync(filePath)) return false;
  const details = await stat(filePath);
  return details.isFile() && details.size >= minimumBytes
    && await sha256File(filePath) === expectedHash;
}

async function download({ url, output, sha256, minimumBytes }) {
  if (await reusable(output, sha256, minimumBytes)) {
    console.log(`Using verified cached artifact: ${output}`);
    return;
  }

  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  const partial = `${output}.part-${process.pid}`;
  await rm(partial, { force: true });

  try {
    console.log(`Downloading ${url}`);
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "ONNXTTS-runtime-installer/0.1" },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with HTTP ${response.status}.`);
    }

    const outputStream = createWriteStream(partial, { flags: "wx" });
    const hash = createHash("sha256");
    let byteCount = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      byteCount += chunk.length;
      if (!outputStream.write(chunk)) await once(outputStream, "drain");
    }
    outputStream.end();
    await finished(outputStream);

    if (byteCount < minimumBytes) {
      throw new Error(`Downloaded artifact is unexpectedly small (${byteCount} bytes).`);
    }
    const actualHash = hash.digest("hex");
    if (actualHash !== sha256) {
      throw new Error(`SHA-256 verification failed for ${output}.`);
    }
    await rename(partial, output);
    console.log(`Verified ${output}`);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function downloadManifest(manifestPath, outputDirectory) {
  const entries = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("The runtime asset manifest must contain at least one entry.");
  }
  for (const entry of entries) {
    if (!entry || entry.filename !== basename(entry.filename || "")) {
      throw new Error("A runtime manifest entry contains an unsafe filename.");
    }
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
      throw new Error(`The runtime manifest has no valid SHA-256 for ${entry.filename}.`);
    }
    const parsedUrl = new URL(entry.url);
    if (parsedUrl.protocol !== "https:") throw new Error("Runtime artifacts must use HTTPS.");
    await download({
      url: entry.url,
      output: join(outputDirectory, entry.filename),
      sha256: entry.sha256.toLowerCase(),
      minimumBytes: 1,
    });
  }
}

try {
  const options = readOptions(process.argv.slice(2));
  if (options.mode === "manifest") {
    await downloadManifest(options.manifest, options.outputDirectory);
  } else {
    await download(options);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
