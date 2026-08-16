/**
 * ONNXTTS application composition root.
 *
 * Model-library and Hugging Face business rules live here. HTTP transport and
 * external synthesis processes are isolated in `server/` adapters.
 */
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOnnxRuntime } from "./server/onnx-runtime.js";
import { createRecordingLibrary } from "./server/recording-library.js";
import { createWebServer } from "./server/web.js";

// Resolve every project path from this module, never from the caller's CWD.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");
const DATA_ROOT = path.join(ROOT, "data");
const LOCAL_MODEL_ROOT = path.join(DATA_ROOT, "models");
const CUSTOM_MODEL_ROOT = path.join(LOCAL_MODEL_ROOT, "custom");
const AUDIO_ROOT = path.join(DATA_ROOT, "audio");
const TEMP_ROOT = path.join(DATA_ROOT, "tmp");


// Read-only escape hatch for future adapters that need the project root.
Object.defineProperty(globalThis, "ONNXTTS_ROOT", {
  value: ROOT,
  writable: false,
  configurable: false,
});

// Parse only the small startup CLI surface; business requests use HTTP JSON.
function commandLineOption(longName, shortName) {
  const equalsPrefix = `${longName}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument.startsWith(equalsPrefix)) return argument.slice(equalsPrefix.length);
    if (argument === longName || argument === shortName) {
      if (index + 1 >= process.argv.length) throw new Error(`${argument} requires a value`);
      return process.argv[index + 1];
    }
  }
  return undefined;
}

function commandLineFlag(...names) {
  return process.argv.slice(2).some((argument) => names.includes(argument));
}

const requestedPort = commandLineOption("--port", "-p") ?? process.env.ONNXTTS_PORT ?? "4317";
const PORT = Number(requestedPort);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid ONNXTTS port: ${requestedPort}. Use an integer from 1 to 65535.`);
}

const HOST = commandLineFlag("-open", "--open")
  ? "0.0.0.0"
  : process.env.ONNXTTS_HOST || "127.0.0.1";
const MODEL_ROOTS = [LOCAL_MODEL_ROOT];

// Create only project-owned data folders; voice models and outputs stay local.
await Promise.all([CUSTOM_MODEL_ROOT, AUDIO_ROOT, TEMP_ROOT].map((dir) => mkdir(dir, { recursive: true })));

// ---------------------------------------------------------------------------
// Local model library
// ---------------------------------------------------------------------------
function modelId(modelPath) {
  return createHash("sha256").update(path.resolve(modelPath).toLowerCase()).digest("hex").slice(0, 16);
}

function titleCase(value) {
  return String(value || "Voice")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function findFiles(root, suffix, output = []) {
  if (!existsSync(root)) return output;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) await findFiles(fullPath, suffix, output);
    else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(fullPath);
  }
  return output;
}

async function scanModels() {
  const models = [];
  const seen = new Set();
  for (const root of MODEL_ROOTS) {
    for (const configPath of await findFiles(root, ".onnx.json")) {
      const onnxPath = configPath.slice(0, -5);
      if (!existsSync(onnxPath)) continue;
      const resolved = path.resolve(onnxPath).toLowerCase();
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      try {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        const fileStats = await stat(onnxPath);
        const basename = path.basename(onnxPath, ".onnx");
        const metadataPath = path.join(path.dirname(onnxPath), ".onnxtts.json");
        let metadata = {};
        if (existsSync(metadataPath)) metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        const dataset = config.dataset || basename.split("-").slice(1, -1).join("-") || basename;
        const quality = config.audio?.quality || basename.split("-").at(-1) || "standard";
        const relativeModelPath = path.relative(LOCAL_MODEL_ROOT, onnxPath);
        const custom = relativeModelPath.split(path.sep)[0]?.toLowerCase() === "custom";
        models.push({
          id: modelId(onnxPath),
          name: titleCase(dataset),
          key: basename,
          language: config.language?.code || "unknown",
          languageName: config.language?.name_english || config.language?.name_native || "Unknown language",
          region: config.language?.country_english || "",
          quality,
          sampleRate: config.audio?.sample_rate || null,
          numSpeakers: config.num_speakers || 1,
          speakers: config.speaker_id_map || {},
          sizeBytes: fileStats.size,
          origin: custom ? "Custom upload" : "ONNXTTS library",
          custom,
          sourceUrl: metadata.sourceUrl || null,
          _path: onnxPath,
        });
      } catch (error) {
        console.warn(`Skipping invalid voice config ${configPath}: ${error.message}`);
      }
    }
  }
  return models.sort((a, b) => a.origin.localeCompare(b.origin) || a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
}

function publicModel(model) {
  const { _path, ...safe } = model;
  return safe;
}

// ---------------------------------------------------------------------------
// Hugging Face voice inspection and installation
// ---------------------------------------------------------------------------
function sanitizeSegment(value) {
  const cleaned = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Invalid model name");
  return cleaned.slice(0, 120);
}

function decodeSegments(segments) {
  return segments.map((part) => decodeURIComponent(part));
}

function parseHuggingFaceUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw Object.assign(new Error("Enter a valid Hugging Face model or folder URL"), { statusCode: 400 });
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "huggingface.co") {
    throw Object.assign(new Error("Only https://huggingface.co model URLs are accepted"), { statusCode: 400 });
  }
  const parts = decodeSegments(url.pathname.split("/").filter(Boolean));
  if (parts.length < 2) throw Object.assign(new Error("The URL must include a Hugging Face owner and repository"), { statusCode: 400 });
  const repoId = `${parts[0]}/${parts[1]}`;
  const action = parts[2];
  let revision = "main";
  let targetPath = "";
  let directFile = false;
  if (["tree", "blob", "resolve"].includes(action)) {
    revision = parts[3] || "main";
    targetPath = parts.slice(4).join("/");
    directFile = action !== "tree";
  } else if (action) {
    throw Object.assign(new Error("Use a Hugging Face repository, folder, or ONNX file URL"), { statusCode: 400 });
  }
  return { repoId, revision, targetPath, directFile, sourceUrl: url.href };
}

function hfHeaders(token) {
  return {
    "User-Agent": "ONNXTTS-Local/0.1",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

async function hfFetch(url, token) {
  const response = await fetch(url, { headers: hfHeaders(token), redirect: "follow" });
  if (!response.ok) {
    const suffix = response.status === 401 || response.status === 403 ? " Check the access token and model permissions." : "";
    throw Object.assign(new Error(`Hugging Face returned ${response.status}.${suffix}`), { statusCode: response.status === 404 ? 404 : 502 });
  }
  return response;
}

async function inspectHuggingFace(rawUrl, token) {
  const parsed = parseHuggingFaceUrl(rawUrl);
  let files = [];
  if (parsed.directFile) {
    if (!parsed.targetPath.endsWith(".onnx") && !parsed.targetPath.endsWith(".onnx.json")) {
      throw Object.assign(new Error("The file URL must point to .onnx or .onnx.json"), { statusCode: 400 });
    }
    const onnxPath = parsed.targetPath.endsWith(".onnx.json") ? parsed.targetPath.slice(0, -5) : parsed.targetPath;
    const folder = path.posix.dirname(onnxPath);
    files = [
      { type: "file", path: onnxPath, size: null },
      { type: "file", path: `${onnxPath}.json`, size: null },
      { type: "file", path: `${folder}/MODEL_CARD`, size: null, optional: true },
    ];
  } else {
    const treeUrl = `https://huggingface.co/api/models/${encodePath(parsed.repoId)}/tree/${encodeURIComponent(parsed.revision)}${parsed.targetPath ? `/${encodePath(parsed.targetPath)}` : ""}`;
    const response = await hfFetch(treeUrl, token);
    const body = await response.json();
    if (!Array.isArray(body)) throw Object.assign(new Error("Unexpected Hugging Face repository response"), { statusCode: 502 });
    files = body;
  }

  const fileMap = new Map(files.filter((item) => item.type === "file").map((item) => [item.path, item]));
  const candidates = [];
  for (const [filePath, item] of fileMap) {
    if (!filePath.endsWith(".onnx")) continue;
    const config = fileMap.get(`${filePath}.json`);
    if (!config) continue;
    const folder = path.posix.dirname(filePath);
    candidates.push({
      name: path.posix.basename(filePath, ".onnx"),
      onnxPath: filePath,
      configPath: `${filePath}.json`,
      modelCardPath: fileMap.has(`${folder}/MODEL_CARD`) ? `${folder}/MODEL_CARD` : null,
      sizeBytes: Number(item.size) || null,
      configSizeBytes: Number(config.size) || null,
    });
  }
  if (!candidates.length) {
    throw Object.assign(new Error("No Piper voice pair was found. Select a folder containing matching .onnx and .onnx.json files."), { statusCode: 422 });
  }
  return { ...parsed, candidates };
}

async function downloadFile(repo, filePath, destination, token, optional = false) {
  const url = `https://huggingface.co/${encodePath(repo.repoId)}/resolve/${encodeURIComponent(repo.revision)}/${encodePath(filePath)}?download=true`;
  let response;
  try {
    response = await hfFetch(url, token);
  } catch (error) {
    if (optional && error.statusCode === 404) return false;
    throw error;
  }
  const contentLength = Number(response.headers.get("content-length")) || 0;
  if (contentLength > 2 * 1024 * 1024 * 1024) throw Object.assign(new Error("Model file is larger than the 2 GB local safety limit"), { statusCode: 413 });
  const partial = `${destination}.part-${randomUUID()}`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
    await rename(partial, destination);
    return true;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function installModel(rawUrl, token) {
  const repo = await inspectHuggingFace(rawUrl, token);
  if (repo.candidates.length !== 1) {
    throw Object.assign(new Error(`This location contains ${repo.candidates.length} Piper voices. Open one voice folder or paste a direct .onnx URL.`), { statusCode: 409 });
  }
  const candidate = repo.candidates[0];
  const folderName = sanitizeSegment(`${repo.repoId.replace("/", "--")}--${candidate.name}`);
  const destinationDir = path.join(LOCAL_MODEL_ROOT, folderName);
  const onnxDestination = path.join(destinationDir, `${sanitizeSegment(candidate.name)}.onnx`);
  const configDestination = `${onnxDestination}.json`;
  const cardDestination = path.join(destinationDir, "MODEL_CARD.md");
  await mkdir(destinationDir, { recursive: true });

  if (existsSync(onnxDestination) && existsSync(configDestination)) {
    return { alreadyInstalled: true, candidate, modelPath: onnxDestination };
  }

  try {
    await downloadFile(repo, candidate.configPath, configDestination, token);
    const config = JSON.parse(await readFile(configDestination, "utf8"));
    const validConfig = Boolean(
      config.audio?.sample_rate
      && config.espeak?.voice
      && config.phoneme_id_map
      && Number.isInteger(config.num_symbols)
      && Number.isInteger(config.num_speakers),
    );
    if (!validConfig) {
      throw Object.assign(new Error("The companion JSON is not a valid Piper voice configuration"), { statusCode: 422 });
    }
    await downloadFile(repo, candidate.onnxPath, onnxDestination, token);
    const onnxStats = await stat(onnxDestination);
    if (onnxStats.size < 100 * 1024) throw new Error("The downloaded ONNX model is unexpectedly small");
    if (candidate.modelCardPath) await downloadFile(repo, candidate.modelCardPath, cardDestination, token, true);
    await writeFile(path.join(destinationDir, ".onnxtts.json"), JSON.stringify({
      sourceUrl: rawUrl,
      repoId: repo.repoId,
      revision: repo.revision,
      installedAt: new Date().toISOString(),
      files: { model: candidate.onnxPath, config: candidate.configPath, modelCard: candidate.modelCardPath },
    }, null, 2), "utf8");
    return { alreadyInstalled: false, candidate, modelPath: onnxDestination };
  } catch (error) {
    await rm(onnxDestination, { force: true });
    await rm(configDestination, { force: true });
    await rm(cardDestination, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Custom ONNX + JSON uploads
// ---------------------------------------------------------------------------
function isValidPiperConfig(config) {
  return Boolean(
    config.audio?.sample_rate
    && config.espeak?.voice
    && config.phoneme_id_map
    && Number.isInteger(config.num_symbols)
    && Number.isInteger(config.num_speakers),
  );
}

async function readMultipartForm(request, limit = 1024 * 1024 * 1024) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw Object.assign(new Error("Upload must use multipart/form-data"), { statusCode: 415 });
  }
  const contentLength = Number(request.headers["content-length"]);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw Object.assign(new Error("Upload requires a valid Content-Length header"), { statusCode: 411 });
  }
  if (contentLength > limit) {
    throw Object.assign(new Error("Upload exceeds the 1 GB local safety limit"), { statusCode: 413 });
  }

  try {
    const webRequest = new Request("http://127.0.0.1/models/upload", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: Readable.toWeb(request),
      duplex: "half",
    });
    return await webRequest.formData();
  } catch (error) {
    throw Object.assign(new Error("The multipart upload could not be read: " + error.message), { statusCode: 400 });
  }
}

function requireUploadedFile(form, fieldName, label) {
  const file = form.get(fieldName);
  if (!file || typeof file !== "object" || typeof file.name !== "string" || typeof file.stream !== "function") {
    throw Object.assign(new Error("Choose a " + label + " file"), { statusCode: 400 });
  }
  return file;
}

async function uploadCustomModel(request) {
  const form = await readMultipartForm(request);
  const modelFile = requireUploadedFile(form, "model", "Piper ONNX model");
  const configFile = requireUploadedFile(form, "config", "Piper JSON configuration");

  if (!modelFile.name.toLowerCase().endsWith(".onnx")) {
    throw Object.assign(new Error("The model file must use the .onnx extension"), { statusCode: 422 });
  }
  if (!configFile.name.toLowerCase().endsWith(".json")) {
    throw Object.assign(new Error("The configuration file must use the .json extension"), { statusCode: 422 });
  }
  if (modelFile.size < 100 * 1024) {
    throw Object.assign(new Error("The ONNX model is unexpectedly small"), { statusCode: 422 });
  }
  if (modelFile.size > 1024 * 1024 * 1024) {
    throw Object.assign(new Error("The ONNX model exceeds the 1 GB local safety limit"), { statusCode: 413 });
  }
  if (configFile.size > 5 * 1024 * 1024) {
    throw Object.assign(new Error("The JSON configuration exceeds the 5 MB safety limit"), { statusCode: 413 });
  }

  let configText;
  let config;
  try {
    configText = await configFile.text();
    config = JSON.parse(configText);
  } catch {
    throw Object.assign(new Error("The configuration file must contain valid JSON"), { statusCode: 422 });
  }
  if (!isValidPiperConfig(config)) {
    throw Object.assign(new Error("The JSON file is not a valid Piper voice configuration"), { statusCode: 422 });
  }

  const sourceName = path.basename(modelFile.name, path.extname(modelFile.name));
  let safeName;
  try {
    safeName = sanitizeSegment(sourceName);
  } catch {
    safeName = "custom-" + Date.now();
  }
  const destinationDir = path.join(CUSTOM_MODEL_ROOT, safeName);
  if (existsSync(destinationDir)) {
    throw Object.assign(new Error("A custom voice named " + safeName + " already exists"), { statusCode: 409 });
  }

  const onnxDestination = path.join(destinationDir, safeName + ".onnx");
  const configDestination = onnxDestination + ".json";
  const partialModel = onnxDestination + ".part-" + randomUUID();
  await mkdir(destinationDir);

  try {
    await writeFile(configDestination, configText, { encoding: "utf8", flag: "wx" });
    await pipeline(Readable.fromWeb(modelFile.stream()), createWriteStream(partialModel, { flags: "wx" }));
    await rename(partialModel, onnxDestination);
    await writeFile(path.join(destinationDir, ".onnxtts.json"), JSON.stringify({
      sourceType: "custom",
      installedAt: new Date().toISOString(),
      originalFiles: { model: modelFile.name, config: configFile.name },
    }, null, 2), "utf8");
    return { modelPath: onnxDestination };
  } catch (error) {
    await rm(destinationDir, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Runtime and HTTP adapter composition
// ---------------------------------------------------------------------------

const onnxRuntime = createOnnxRuntime({
  root: ROOT,
  audioRoot: AUDIO_ROOT,
  tempRoot: TEMP_ROOT,
  scanModels,
  toPublicModel: publicModel,
});
const recordingLibrary = createRecordingLibrary({ audioRoot: AUDIO_ROOT });

const server = createWebServer({
  host: HOST,
  port: PORT,
  publicRoot: PUBLIC_ROOT,
  audioRoot: AUDIO_ROOT,
  defaultHfToken: process.env.HF_TOKEN,
  runtimeStatus: onnxRuntime.status,
  services: {
    scanModels,
    toPublicModel: publicModel,
    inspectHuggingFace,
    installModel,
    uploadCustomModel,
    generateAudio: onnxRuntime.generateAudio,
    listRecordings: recordingLibrary.listRecordings,
    getRecording: recordingLibrary.getRecording,
    deleteRecordings: recordingLibrary.deleteRecordings,
  },
});
server.listen(PORT, HOST, () => {
  console.log(`ONNXTTS is ready at http://${HOST}:${PORT}`);
  console.log(`Voice library: ${LOCAL_MODEL_ROOT}`);
  console.log("Python: " + onnxRuntime.paths.python);
  console.log("Piper packages: " + onnxRuntime.paths.piperRuntime);
  console.log("FFmpeg: " + onnxRuntime.paths.ffmpeg);
  const queue = onnxRuntime.status().queue;
  console.log(`Synthesis queue: ${queue.workers} workers · ${queue.queueLimit} waiting jobs`);
});

// Close active connections promptly when CMD forwards Ctrl+C or the OS stops us.
let shutdownStarted = false;

function shutdown(signal) {
  if (shutdownStarted) {
    process.exit(0);
    return;
  }
  shutdownStarted = true;
  console.log(`\n${signal} received. Stopping ONNXTTS...`);
  onnxRuntime.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

process.on("SIGINT", () => shutdown("Ctrl+C"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
