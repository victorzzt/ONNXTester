/** Execute one synthesis job outside the HTTP server's main event loop. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const OUTPUT_LIMIT = 512 * 1024;

function isolatedPythonEnvironment() {
  const env = { ...process.env, PYTHONNOUSERSITE: "1" };
  for (const name of [
    "PYTHONHOME",
    "PYTHONPATH",
    "CONDA_PREFIX",
    "CONDA_DEFAULT_ENV",
    "CONDA_PROMPT_MODIFIER",
    "_CE_CONDA",
    "_CE_M",
  ]) delete env[name];
  return env;
}

function runProcess(command, args, { timeout = 10 * 60 * 1000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workerData.root,
      env,
      windowsHide: process.platform === "win32",
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);

    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-OUTPUT_LIMIT); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-OUTPUT_LIMIT); });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (timedOut) return finish(reject, new Error(`${path.basename(command)} timed out.`));
      if (code === 0) return finish(resolve, { stdout: stdout.trim(), stderr: stderr.trim() });
      return finish(reject, new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function renderAudio() {
  const { job, audioRoot, tempRoot, python, piperRuntime, ffmpeg, bridge } = workerData;

  // Keep the existing timestamp-plus-UUID basename stable across audio, sidecar,
  // URLs, and cleanup. Temporary inputs use the same id but live outside the
  // persistent audio library.
  const jobId = `${Date.now()}-${randomUUID()}`;
  const transcriptPath = path.join(tempRoot, `${jobId}.txt`);
  const sentencesPath = path.join(tempRoot, `${jobId}.sentences.json`);
  const wavPath = path.join(audioRoot, `${jobId}.wav`);
  const finalPath = path.join(audioRoot, `${jobId}.${job.format}`);
  const metadataPath = path.join(audioRoot, `${jobId}.json`);
  const metadataTempPath = path.join(tempRoot, `${jobId}.metadata.json`);

  // The bridge reads files rather than workerData so a Python child never needs
  // access to Node's in-memory job object.
  await Promise.all([
    writeFile(transcriptPath, job.text, "utf8"),
    writeFile(sentencesPath, JSON.stringify(job.sentences), "utf8"),
  ]);

  try {
    const args = [
      bridge,
      "--runtime", piperRuntime,
      "--model", job.modelPath,
      "--input", transcriptPath,
      "--sentences", sentencesPath,
      "--output", wavPath,
      "--length-scale", String(job.lengthScale),
      "--sentence-silence", String(job.sentenceSilence),
      "--volume", String(job.volume),
    ];
    if (job.speakerId != null) args.push("--speaker-id", String(job.speakerId));

    const rendered = await runProcess(python, ["-I", "-S", ...args], { env: isolatedPythonEnvironment() });
    // synthesize_piper.py reserves its final stdout line for machine-readable
    // PCM-derived metadata; earlier output may contain human diagnostic text.
    const metadataLine = rendered.stdout.split(/\r?\n/).at(-1);
    let details;
    try {
      details = JSON.parse(metadataLine);
    } catch {
      throw new Error("The synthesis bridge did not return valid timing metadata.");
    }

    // Timings remain those measured from the source PCM. MP3 conversion changes
    // only the persisted audio format and never rewrites the timing list.
    if (job.format === "mp3") {
      await runProcess(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", wavPath,
        "-codec:a", "libmp3lame", "-q:a", "2", finalPath,
      ]);
      await rm(wavPath, { force: true });
    }

    const fileName = path.basename(finalPath);
    // Schema version 1 stores only public model data and playback metadata. The
    // final audio bytes are already complete at this point and are not reopened
    // or modified while the sidecar is constructed.
    const metadata = {
      schemaVersion: 1,
      id: jobId,
      createdAt: new Date().toISOString(),
      text: job.text,
      sentences: Array.isArray(details.sentences) ? details.sentences : [],
      model: job.model,
      audio: {
        fileName,
        format: job.format,
        duration: details.duration,
        sampleRate: details.sampleRate,
        channels: details.channels,
        bitsPerSample: details.bitsPerSample,
      },
    };
    // Publish the JSON only after a complete write. tempRoot and audioRoot are
    // project-local siblings on the same volume, so rename gives readers either
    // no sidecar or the complete sidecar, never a partially written JSON file.
    await writeFile(metadataTempPath, JSON.stringify(metadata, null, 2), "utf8");
    await rename(metadataTempPath, metadataPath);

    return {
      id: jobId,
      format: job.format,
      model: job.model,
      mediaUrl: `/media/${encodeURIComponent(fileName)}`,
      downloadUrl: `/api/download/${encodeURIComponent(fileName)}`,
      ...details,
    };
  } catch (error) {
    // A job is successful only when audio and metadata both exist. Remove every
    // possible persistent output on failure so the library cannot expose a half
    // pair; force also makes cleanup safe when a file was never created.
    await rm(wavPath, { force: true });
    if (job.format === "mp3") await rm(finalPath, { force: true });
    await rm(metadataPath, { force: true });
    throw error;
  } finally {
    // Inputs and an unpublished metadata file are always disposable, including
    // after Python/FFmpeg errors or a successful final rename.
    await Promise.all([
      rm(transcriptPath, { force: true }),
      rm(sentencesPath, { force: true }),
      rm(metadataTempPath, { force: true }),
    ]);
  }
}

try {
  parentPort.postMessage({ ok: true, result: await renderAudio() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  parentPort.close();
}
