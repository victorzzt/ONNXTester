/**
 * Project-local Piper/ONNX runtime adapter.
 *
 * This module owns every external process used for synthesis: it bootstraps
 * the isolated runtime when required, invokes the Python bridge, optionally
 * converts WAV output with FFmpeg, and prevents concurrent model loads.
 */
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const ISOLATED_PYTHON_VARIABLES = [
  "PYTHONHOME",
  "PYTHONPATH",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "CONDA_PROMPT_MODIFIER",
  "_CE_CONDA",
  "_CE_M",
];

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Creates one synthesis runtime for the current project.
 * `scanModels` and `toPublicModel` keep model-library knowledge outside this
 * process adapter while still allowing it to validate a requested model.
 */
export function createOnnxRuntime({ root, audioRoot, tempRoot, scanModels, toPublicModel }) {
  const localEnvironmentRoot = path.join(root, ".local-env");
  const localPython = path.join(localEnvironmentRoot, "python", "python.exe");
  const localPackages = path.join(localEnvironmentRoot, "packages");
  const localFfmpeg = path.join(localEnvironmentRoot, "ffmpeg", "bin", "ffmpeg.exe");
  const localSetup = path.join(root, "set_local_env.cmd");
  const localMarker = path.join(localEnvironmentRoot, "install.json");

  // Explicit environment variables remain supported for advanced users.
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

  // A missing default runtime is installed before the HTTP server starts.
  function ensureLocalEnvironment() {
    if (requiredLocalEnvironmentReady()) return;
    if (process.platform !== "win32") {
      throw new Error("The bundled runtime installer currently supports Windows only.");
    }
    if (!existsSync(localSetup)) {
      throw new Error("The local runtime is incomplete and " + localSetup + " was not found.");
    }

    console.log("Project-local runtime dependencies are missing. Installing them now...");
    const commandProcessor = process.env.ComSpec || "cmd.exe";
    const result = spawnSync(commandProcessor, ["/d", "/c", "call", localSetup, "-install"], {
      cwd: root,
      stdio: "inherit",
      windowsHide: false,
    });
    if (result.error) throw new Error("Unable to start the local environment installer: " + result.error.message);
    if (result.status !== 0) throw new Error("Local environment installation failed with exit code " + result.status + ".");
    if (!requiredLocalEnvironmentReady()) throw new Error("The installer completed, but the required local runtime is incomplete.");
  }

  // Prevent system Python, user site-packages, or Conda from leaking in.
  function isolatedPythonEnvironment() {
    const env = { ...process.env, PYTHONNOUSERSITE: "1" };
    for (const name of ISOLATED_PYTHON_VARIABLES) delete env[name];
    return env;
  }

  /** Runs a child process without a shell and retains bounded diagnostics. */
  function runProcess(command, args, { timeout = 10 * 60 * 1000, env = process.env } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: root, env, windowsHide: true, shell: false });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), timeout);
      child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-128 * 1024); });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-128 * 1024); });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        else reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} exited with code ${code}`));
      });
    });
  }

  /** Validates one request, invokes Piper, and returns public audio metadata. */
  async function renderAudio(body) {
    const text = String(body.text || "").trim();
    if (!text) throw httpError("Paste a transcript before generating audio", 400);
    if (text.length > 50_000) throw httpError("Transcript exceeds the 50,000 character limit", 413);

    const models = await scanModels();
    const model = models.find((item) => item.id === body.modelId);
    if (!model) throw httpError("The selected voice is no longer available", 404);

    const format = body.format === "mp3" ? "mp3" : "wav";
    const lengthScale = Math.min(2, Math.max(0.5, Number(body.lengthScale) || 1));
    const sentenceSilence = Math.min(2, Math.max(0, Number(body.sentenceSilence) || 0));
    const volume = Math.min(1.5, Math.max(0.1, Number(body.volume) || 0.92));
    const speakerId = body.speakerId === "" || body.speakerId == null ? null : Number(body.speakerId);
    if (speakerId != null && (!Number.isInteger(speakerId) || speakerId < 0 || speakerId >= model.numSpeakers)) {
      throw httpError("Select a valid speaker for this voice", 400);
    }

    const jobId = `${Date.now()}-${randomUUID()}`;
    const transcriptPath = path.join(tempRoot, `${jobId}.txt`);
    const wavPath = path.join(audioRoot, `${jobId}.wav`);
    const finalPath = path.join(audioRoot, `${jobId}.${format}`);
    await writeFile(transcriptPath, text, "utf8");

    try {
      const args = [
        bridge,
        "--runtime", piperRuntime,
        "--model", model._path,
        "--input", transcriptPath,
        "--output", wavPath,
        "--length-scale", String(lengthScale),
        "--sentence-silence", String(sentenceSilence),
        "--volume", String(volume),
      ];
      if (speakerId != null) args.push("--speaker-id", String(speakerId));

      const rendered = await runProcess(python, ["-I", "-S", ...args], { env: isolatedPythonEnvironment() });
      let details = {};
      try { details = JSON.parse(rendered.stdout.split(/\r?\n/).at(-1)); } catch { /* Bridge metadata is optional. */ }

      if (format === "mp3") {
        await runProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, "-codec:a", "libmp3lame", "-q:a", "2", finalPath]);
        await rm(wavPath, { force: true });
      }

      const fileName = path.basename(finalPath);
      return {
        id: jobId,
        format,
        model: toPublicModel(model),
        mediaUrl: `/media/${encodeURIComponent(fileName)}`,
        downloadUrl: `/api/download/${encodeURIComponent(fileName)}`,
        ...details,
      };
    } catch (error) {
      await rm(wavPath, { force: true });
      if (format === "mp3") await rm(finalPath, { force: true });
      throw error;
    } finally {
      await rm(transcriptPath, { force: true });
    }
  }

  ensureLocalEnvironment();
  let synthesisRunning = false;

  /** Serializes synthesis so two large ONNX models are never loaded together. */
  async function generateAudio(body) {
    if (synthesisRunning) throw httpError("A voice is already being rendered. Please wait for it to finish.", 409);
    synthesisRunning = true;
    try {
      return await renderAudio(body);
    } finally {
      synthesisRunning = false;
    }
  }

  /** Values used by `/api/health`; no absolute paths are exposed to clients. */
  function status() {
    return {
      python: existsSync(python),
      piper: existsSync(path.join(piperRuntime, "piper", "__init__.py")),
      ffmpeg: existsSync(ffmpeg),
    };
  }

  return Object.freeze({
    generateAudio,
    status,
    paths: Object.freeze({ python, piperRuntime, ffmpeg, bridge }),
  });
}