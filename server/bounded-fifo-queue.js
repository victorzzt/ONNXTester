/**
 * Bounded FIFO scheduler shared by production synthesis and debug tests.
 * The executor may create a worker thread, a child process, or a fake task.
 */
export const QUEUE_FULL_MESSAGE = "Too Many Request, please wait for a while.";

function queueError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export class BoundedFifoQueue {
  #active = 0;
  #closed = false;
  #nextId = 1;
  #waiting = [];

  constructor({ concurrency, queueLimit, executor }) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive integer");
    if (!Number.isInteger(queueLimit) || queueLimit < 1) throw new TypeError("queueLimit must be a positive integer");
    if (typeof executor !== "function") throw new TypeError("executor must be a function");
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
    this.executor = executor;
  }

  enqueue(payload) {
    if (this.#closed) return Promise.reject(queueError("The synthesis queue is shutting down.", 503));
    if (this.#active >= this.concurrency && this.#waiting.length >= this.queueLimit) {
      return Promise.reject(queueError(QUEUE_FULL_MESSAGE, 429));
    }

    return new Promise((resolve, reject) => {
      this.#waiting.push({ id: this.#nextId, payload, resolve, reject });
      this.#nextId += 1;
      this.#drain();
    });
  }

  #drain() {
    while (!this.#closed && this.#active < this.concurrency && this.#waiting.length) {
      const task = this.#waiting.shift();
      this.#active += 1;
      Promise.resolve()
        .then(() => this.executor(task.payload, { id: task.id }))
        .then(task.resolve, task.reject)
        .finally(() => {
          this.#active -= 1;
          this.#drain();
        });
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    const error = queueError("The synthesis queue is shutting down.", 503);
    for (const task of this.#waiting.splice(0)) task.reject(error);
  }

  status() {
    return {
      workers: this.concurrency,
      active: this.#active,
      queued: this.#waiting.length,
      queueLimit: this.queueLimit,
    };
  }
}
