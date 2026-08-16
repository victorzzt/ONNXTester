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
  const jobId = `${Date.now()}-${randomUUID()}`;
  const transcriptPath = path.join(tempRoot, `${jobId}.txt`);
  const sentencesPath = path.join(tempRoot, `${jobId}.sentences.json`);
  const wavPath = path.join(audioRoot, `${jobId}.wav`);
  const finalPath = path.join(audioRoot, `${jobId}.${job.format}`);
  const metadataPath = path.join(audioRoot, `${jobId}.json`);
  const metadataTempPath = path.join(tempRoot, `${jobId}.metadata.json`);
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
    const metadataLine = rendered.stdout.split(/\r?\n/).at(-1);
    let details;
    try {
      details = JSON.parse(metadataLine);
    } catch {
      throw new Error("The synthesis bridge did not return valid timing metadata.");
    }

    if (job.format === "mp3") {
      await runProcess(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", wavPath,
        "-codec:a", "libmp3lame", "-q:a", "2", finalPath,
      ]);
      await rm(wavPath, { force: true });
    }

    const fileName = path.basename(finalPath);
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
    await rm(wavPath, { force: true });
    if (job.format === "mp3") await rm(finalPath, { force: true });
    await rm(metadataPath, { force: true });
    throw error;
  } finally {
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
