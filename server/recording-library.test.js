import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRecordingLibrary } from "./recording-library.js";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

async function writeRecording(root, id, { createdAt, text, format = "wav" }) {
  await writeFile(path.join(root, `${id}.${format}`), Buffer.from("unchanged-audio"));
  await writeFile(path.join(root, `${id}.json`), JSON.stringify({
    schemaVersion: 1,
    id,
    createdAt,
    text,
    sentences: [
      { text: "Valid sentence.", start: 0, end: 1.25 },
      { text: "Invalid sentence.", start: 2, end: 1 },
    ],
    model: { name: "Test voice" },
    audio: { format, duration: 1.25, sampleRate: 22_050 },
  }), "utf8");
}

test("recording sidecars list, load, and delete only their UUID audio", async (context) => {
  const audioRoot = await mkdtemp(path.join(tmpdir(), "onnxtts-recordings-"));
  context.after(async () => rm(audioRoot, { recursive: true, force: true }));
  await writeRecording(audioRoot, FIRST_ID, {
    createdAt: "2026-08-15T12:00:00.000Z",
    text: "Alpha recording remains intact.",
  });
  await writeRecording(audioRoot, SECOND_ID, {
    createdAt: "2026-08-16T12:00:00.000Z",
    text: "Beta recording is newer.",
    format: "mp3",
  });
  await writeFile(path.join(audioRoot, "orphan.wav"), Buffer.from("orphan"));

  const library = createRecordingLibrary({ audioRoot });
  const listed = await library.listRecordings();
  assert.deepEqual(listed.map((recording) => recording.id), [SECOND_ID, FIRST_ID]);
  assert.equal(listed[0].textPreview, "Beta recording is newer.");
  assert.equal(listed[0].modelName, "Test voice");

  const loaded = await library.getRecording(FIRST_ID);
  assert.equal(loaded.text, "Alpha recording remains intact.");
  assert.deepEqual(loaded.sentences, [{ text: "Valid sentence.", start: 0, end: 1.25 }]);
  assert.equal(loaded.mediaUrl, `/media/${FIRST_ID}.wav`);
  assert.equal(await readFile(path.join(audioRoot, `${FIRST_ID}.wav`), "utf8"), "unchanged-audio");

  await assert.rejects(
    library.getRecording("../outside"),
    (error) => error.statusCode === 400 && error.message === "Invalid recording id",
  );

  const selectedDeletion = await library.deleteRecordings({ ids: [FIRST_ID] });
  assert.deepEqual(selectedDeletion, { deleted: [FIRST_ID], count: 1 });
  await assert.rejects(readFile(path.join(audioRoot, `${FIRST_ID}.wav`)), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(audioRoot, `${FIRST_ID}.json`)), { code: "ENOENT" });
  assert.equal(await readFile(path.join(audioRoot, `${SECOND_ID}.mp3`), "utf8"), "unchanged-audio");

  const clearDeletion = await library.deleteRecordings({ all: true });
  assert.deepEqual(clearDeletion, { deleted: [SECOND_ID], count: 1 });
  assert.equal(await readFile(path.join(audioRoot, "orphan.wav"), "utf8"), "orphan");
});
