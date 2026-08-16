/**
 * Filesystem contract tests for the persistent recording library.
 *
 * These tests deliberately use Node's built-in runner and a fresh OS temporary
 * directory. They never point at the project's real data/audio directory, so a
 * failed assertion or cleanup cannot remove a user's generated recordings. The
 * suite exercises the same sidecar-driven list/load/delete boundary used by the
 * HTTP routes without requiring a server, Piper model, or generated audio.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRecordingLibrary } from "./recording-library.js";

// Stable UUIDs make ordering and exact deletion assertions easy to read. They
// are syntactically valid recording ids but cannot collide outside this test's
// unique temporary directory.
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Writes the smallest useful audio/sidecar fixture.
 *
 * The audio payload is a sentinel rather than a playable file because the
 * recording library must treat audio as opaque bytes. One valid and one invalid
 * cue are stored on purpose: loading must keep the first and defensively discard
 * the reversed time range without changing the source JSON.
 *
 * @param {string} root isolated audio directory created by the test
 * @param {string} id basename shared by the audio and JSON sidecar
 * @param {{createdAt: string, text: string, format?: "wav"|"mp3"}} metadata
 */
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
  // mkdtemp guarantees a directory that did not exist before this test. The
  // registered hook runs on success and failure, containing recursive cleanup
  // to that verified OS-temp child rather than any repository path.
  const audioRoot = await mkdtemp(path.join(tmpdir(), "onnxtts-recordings-"));
  context.after(async () => rm(audioRoot, { recursive: true, force: true }));

  // Use both supported formats and deliberately write them out of chronological
  // order so the listing assertion proves it sorts by createdAt, not directory
  // enumeration order or filename.
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

  // Listing is a compact projection for the dialog: newest first, bounded text
  // preview, and public model name. The orphan has no sidecar and must be absent.
  const library = createRecordingLibrary({ audioRoot });
  const listed = await library.listRecordings();
  assert.deepEqual(listed.map((recording) => recording.id), [SECOND_ID, FIRST_ID]);
  assert.equal(listed[0].textPreview, "Beta recording is newer.");
  assert.equal(listed[0].modelName, "Test voice");

  // Full loading revalidates metadata, filters malformed cues, derives URLs from
  // the validated id, and leaves the audio sentinel byte-for-byte unchanged.
  const loaded = await library.getRecording(FIRST_ID);
  assert.equal(loaded.text, "Alpha recording remains intact.");
  assert.deepEqual(loaded.sentences, [{ text: "Valid sentence.", start: 0, end: 1.25 }]);
  assert.equal(loaded.mediaUrl, `/media/${FIRST_ID}.wav`);
  assert.equal(await readFile(path.join(audioRoot, `${FIRST_ID}.wav`), "utf8"), "unchanged-audio");

  // A traversal-looking id must fail validation before path.join can be used to
  // inspect the filesystem. Checking both status and message protects HTTP error
  // mapping as well as the underlying path boundary.
  await assert.rejects(
    library.getRecording("../outside"),
    (error) => error.statusCode === 400 && error.message === "Invalid recording id",
  );

  // Selected deletion must remove the chosen sidecar and matching audio only.
  // The second recording is checked afterward to catch an accidentally broad
  // glob, directory cleanup, or format-independent filename mistake.
  const selectedDeletion = await library.deleteRecordings({ ids: [FIRST_ID] });
  assert.deepEqual(selectedDeletion, { deleted: [FIRST_ID], count: 1 });
  await assert.rejects(readFile(path.join(audioRoot, `${FIRST_ID}.wav`)), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(audioRoot, `${FIRST_ID}.json`)), { code: "ENOENT" });
  assert.equal(await readFile(path.join(audioRoot, `${SECOND_ID}.mp3`), "utf8"), "unchanged-audio");

  // Clear is intentionally sidecar-driven. It removes every remaining valid
  // library entry, while unrelated/orphan files stay untouched for manual
  // inspection instead of being swept up by a wildcard.
  const clearDeletion = await library.deleteRecordings({ all: true });
  assert.deepEqual(clearDeletion, { deleted: [SECOND_ID], count: 1 });
  assert.equal(await readFile(path.join(audioRoot, "orphan.wav"), "utf8"), "orphan");
});
