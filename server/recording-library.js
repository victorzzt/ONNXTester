/** Persistent recording metadata and deletion service for data/audio. */
import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const RECORDING_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function validateId(value) {
  const id = String(value || "");
  if (!RECORDING_ID.test(id)) throw httpError("Invalid recording id", 400);
  return id;
}

function normalizeSentences(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((sentence) => ({
      text: String(sentence?.text || "").trim(),
      start: Number(sentence?.start),
      end: Number(sentence?.end),
    }))
    .filter((sentence) => sentence.text
      && Number.isFinite(sentence.start)
      && Number.isFinite(sentence.end)
      && sentence.start >= 0
      && sentence.end >= sentence.start);
}

export function createRecordingLibrary({ audioRoot }) {
  async function readRecording(value) {
    const id = validateId(value);
    const metadataPath = path.join(audioRoot, `${id}.json`);
    let metadataStats;
    try {
      metadataStats = await stat(metadataPath);
    } catch (error) {
      if (error.code === "ENOENT") throw httpError("Recording not found", 404);
      throw error;
    }
    if (!metadataStats.isFile() || metadataStats.size > MAX_METADATA_BYTES) {
      throw httpError("Recording metadata is invalid", 500);
    }

    let metadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch {
      throw httpError("Recording metadata is invalid", 500);
    }

    const text = typeof metadata.text === "string" ? metadata.text : "";
    if (!text || text.length > 50_000) throw httpError("Recording metadata is invalid", 500);
    const format = metadata.audio?.format === "mp3" || metadata.format === "mp3" ? "mp3" : "wav";
    const fileName = `${id}.${format}`;
    const audioPath = path.join(audioRoot, fileName);
    if (!existsSync(audioPath)) throw httpError("Recording audio not found", 404);

    const createdValue = Date.parse(metadata.createdAt);
    const createdAt = new Date(Number.isFinite(createdValue) ? createdValue : metadataStats.mtimeMs).toISOString();
    const duration = Number(metadata.audio?.duration ?? metadata.duration);
    const sampleRate = Number(metadata.audio?.sampleRate ?? metadata.sampleRate);
    return {
      id,
      createdAt,
      text,
      sentences: normalizeSentences(metadata.sentences),
      format,
      duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
      sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null,
      model: metadata.model && typeof metadata.model === "object" ? metadata.model : null,
      mediaUrl: `/media/${encodeURIComponent(fileName)}`,
      downloadUrl: `/api/download/${encodeURIComponent(fileName)}`,
    };
  }

  async function listRecordings() {
    const entries = await readdir(audioRoot, { withFileTypes: true });
    const recordings = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
      const id = path.basename(entry.name, ".json");
      if (!RECORDING_ID.test(id)) continue;
      try {
        const recording = await readRecording(id);
        recordings.push({
          id: recording.id,
          createdAt: recording.createdAt,
          textPreview: recording.text.slice(0, 512),
          format: recording.format,
          duration: recording.duration,
          modelName: recording.model?.name || null,
        });
      } catch {
        // Corrupt or orphaned sidecars remain on disk for manual inspection but
        // are never presented as loadable recordings.
      }
    }
    return recordings.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async function deleteRecordings({ ids, all = false } = {}) {
    let targets;
    if (all === true) {
      targets = (await listRecordings()).map((recording) => recording.id);
    } else {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000) {
        throw httpError("Select between 1 and 1,000 recordings", 400);
      }
      targets = [...new Set(ids.map(validateId))];
    }

    const deleted = [];
    for (const id of targets) {
      const metadataPath = path.join(audioRoot, `${id}.json`);
      if (!existsSync(metadataPath)) continue;
      await Promise.all([
        rm(metadataPath, { force: true }),
        rm(path.join(audioRoot, `${id}.wav`), { force: true }),
        rm(path.join(audioRoot, `${id}.mp3`), { force: true }),
      ]);
      deleted.push(id);
    }
    return { deleted, count: deleted.length };
  }

  return Object.freeze({ listRecordings, getRecording: readRecording, deleteRecordings });
}
