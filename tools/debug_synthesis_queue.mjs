import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { BoundedFifoQueue, QUEUE_FULL_MESSAGE } from "../server/bounded-fifo-queue.js";

let active = 0;
let maxActive = 0;
const startOrder = [];
const queue = new BoundedFifoQueue({
  concurrency: 2,
  queueLimit: 2,
  executor: async ({ id, duration }) => {
    startOrder.push(id);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await delay(duration);
      return id;
    } finally {
      active -= 1;
    }
  },
});

const jobs = [
  queue.enqueue({ id: "job-1", duration: 80 }),
  queue.enqueue({ id: "job-2", duration: 20 }),
  queue.enqueue({ id: "job-3", duration: 15 }),
  queue.enqueue({ id: "job-4", duration: 10 }),
];
assert.deepEqual(queue.status(), { workers: 2, active: 2, queued: 2, queueLimit: 2 });

const overflow = await queue.enqueue({ id: "job-5", duration: 1 }).then(
  () => null,
  (error) => error,
);
assert(overflow instanceof Error);
assert.equal(overflow.statusCode, 429);
assert.equal(overflow.message, QUEUE_FULL_MESSAGE);

const results = await Promise.all(jobs);
assert.deepEqual(results, ["job-1", "job-2", "job-3", "job-4"]);
assert.deepEqual(startOrder, ["job-1", "job-2", "job-3", "job-4"]);
assert.equal(maxActive, 2);
assert.deepEqual(queue.status(), { workers: 2, active: 0, queued: 0, queueLimit: 2 });

console.log("Synthesis queue debug test passed.");
console.log(JSON.stringify({ startOrder, maxActive, overflow: { statusCode: overflow.statusCode, message: overflow.message } }, null, 2));
