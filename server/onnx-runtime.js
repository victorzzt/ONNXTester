/**
 * Project-local Piper/ONNX runtime adapter.
 *
 * Request validation stays on the HTTP thread. Actual Python/FFmpeg synthesis
 * runs in one worker thread per job behind a CPU-sized bounded FIFO queue.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { BoundedFifoQueue } from "./bounded-fifo-queue.js";

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function configuredInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    console.warn(`Ignoring invalid ${name}=${raw}; using ${fallback}.`);
    return fallback;
  }
  return value;
}

function segmentSentences(text) {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    const sentences = Array.from(segmenter.segment(text), ({ segment }) => segment.trim()).filter(Boolean);
    if (sentences.length) return sentences;
  }
  return text.match(/[^.!?。！？]+[.!?。！？]*|[.!?。！？]+/gu)?.map((sentence) => sentence.trim()).filter(Boolean) || [text];
}

/** Creates one synthesis runtime for the current project. */
export function createOnnxRuntime({ root, audioRoot, tempRoot, scanModels, toPublicModel }) {
  const isWindows = process.platform === "win32";
  const isLinux = process.platform === "linux";
  const localEnvironmentRoot = path.join(root, ".local-env");
  const localPython = isWindows
    ? path.join(localEnvironmentRoot, "python", "python.exe")
    : path.join(localEnvironmentRoot, "python", "bin", "python3");
  const localPackages = path.join(localEnvironmentRoot, "packages");
  const localFfmpeg = path.join(localEnvironmentRoot, "ffmpeg", "bin", isWindows ? "ffmpeg.exe" : "ffmpeg");
  const localSetup = path.join(root, isWindows ? "set_local_env.cmd" : "set_local_env.sh");
  const localMarker = path.join(localEnvironmentRoot, "install.json");

  const usingLocalPython = !process.env.ONNXTTS_PYTHON && !process.env.ONNXTTS_PIPER_RUNTIME;
  const usingLocalFfmpeg = !process.env.ONNXTTS_FFMPEG;
  const python = process.env.ONNXTTS_PYTHON || localPython;
  const piperRuntime = process.env.ONNXTTS_PIPER_RUNTIME || localPackages;
  const ffmpeg = process.env.ONNXTTS_FFMPEG || localFfmpeg;
  const bridge = path.join(root, "tools", "synthesize_piper.py");

  function localPythonEnvironmentReady() {
    return existsSync(localPython)
      && existsSync(path.join(localPackages, "piper", "__init__.py"))
      && existsSync(path.join(localPackages, "onnxruntime", "__init__.py"))
      && existsSync(localMarker);
  }

  function requiredLocalEnvironmentReady() {
    return (!usingLocalPython || localPythonEnvironmentReady())
      && (!usingLocalFfmpeg || existsSync(localFfmpeg));
  }

  function ensureLocalEnvironment() {
    if (requiredLocalEnvironmentReady()) return;
    if (!isWindows && !isLinux) {
      throw new Error(`The bundled runtime installer does not support ${process.platform}.`);
    }
    if (!existsSync(localSetup)) {
      throw new Error("The local runtime is incomplete and " + localSetup + " was not found.");
    }

    console.log("Project-local runtime dependencies are missing. Installing them now...");
    const installer = isWindows
      ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", "call", localSetup, "-install"] }
      : { command: "sh", args: [localSetup, "-install"] };
    const result = spawnSync(installer.command, installer.args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: isWindows,
    });
    if (result.error) throw new Error("Unable to start the local environment installer: " + result.error.message);
    if (result.status !== 0) throw new Error("Local environment installation failed with exit code " + result.status + ".");
    if (!requiredLocalEnvironmentReady()) throw new Error("The installer completed, but the required local runtime is incomplete.");
  }

  function runSynthesisWorker(job) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./synthesis-worker.js", import.meta.url), {
        workerData: {
          root,
          audioRoot,
          tempRoot,
          python,
          piperRuntime,
          ffmpeg,
          bridge,
          job,
        },
      });
      let message;
      let workerError;
      worker.once("message", (value) => { message = value; });
      worker.once("error", (error) => { workerError = error; });
      worker.once("exit", (code) => {
        if (workerError) return reject(workerError);
        if (code !== 0) return reject(new Error(`Synthesis worker exited with code ${code}.`));
        if (!message) return reject(new Error("Synthesis worker exited without a result."));
        if (!message.ok) return reject(new Error(message.error || "Synthesis worker failed."));
        return resolve(message.result);
      });
    });
  }

  async function prepareJob(body) {
    const text = String(body.text || "").trim();
    if (!text) throw httpError("Paste a transcript before generating audio", 400);
    if (text.length > 50_000) throw httpError("Transcript exceeds the 50,000 character limit", 413);

    const models = await scanModels();
    const model = models.find((item) => item.id === body.modelId);
    if (!model) throw httpError("The selected voice is no longer available", 404);

    const speakerId = body.speakerId === "" || body.speakerId == null ? null : Number(body.speakerId);
    if (speakerId != null && (!Number.isInteger(speakerId) || speakerId < 0 || speakerId >= model.numSpeakers)) {
      throw httpError("Select a valid speaker for this voice", 400);
    }

    return {
      text,
      sentences: segmentSentences(text),
      modelPath: model._path,
      model: toPublicModel(model),
      format: body.format === "mp3" ? "mp3" : "wav",
      lengthScale: Math.min(2, Math.max(0.5, Number(body.lengthScale) || 1)),
      sentenceSilence: Math.min(2, Math.max(0, Number(body.sentenceSilence) || 0)),
      volume: Math.min(1.5, Math.max(0.1, Number(body.volume) || 0.92)),
      speakerId,
    };
  }

  ensureLocalEnvironment();
  const cpuParallelism = availableParallelism();
  const inferredWorkers = Math.max(1, Math.min(4, Math.ceil(cpuParallelism / 2)));
  const workerCount = configuredInteger("ONNXTTS_SYNTHESIS_WORKERS", inferredWorkers, 1, 32);
  const inferredQueueLimit = Math.max(4, Math.min(16, workerCount * 4));
  const queueLimit = configuredInteger("ONNXTTS_SYNTHESIS_QUEUE_LIMIT", inferredQueueLimit, 1, 1000);
  const synthesisQueue = new BoundedFifoQueue({
    concurrency: workerCount,
    queueLimit,
    executor: runSynthesisWorker,
  });

  async function generateAudio(body) {
    return synthesisQueue.enqueue(await prepareJob(body));
  }

  function status() {
    return {
      python: existsSync(python),
      piper: existsSync(path.join(piperRuntime, "piper", "__init__.py")),
      ffmpeg: existsSync(ffmpeg),
      queue: {
        cpuParallelism,
        ...synthesisQueue.status(),
      },
    };
  }

  return Object.freeze({
    generateAudio,
    status,
    close: () => synthesisQueue.close(),
    paths: Object.freeze({ python, piperRuntime, ffmpeg, bridge }),
  });
}
