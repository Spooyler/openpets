/**
 * speech-bubble-queue.ts — queued speech bubbles for multi-session hub mode.
 *
 * One bubble visible at a time. Enqueuing from the current bubble's session
 * replaces it immediately; other sessions queue (bounded, oldest dropped).
 */

export interface BubbleContent {
  readonly sessionKey: string;
  readonly label: string;
  readonly message: string;
}

export class SpeechBubbleQueue {
  readonly #maxDepth: number;
  #current: BubbleContent | null = null;
  readonly #queue: BubbleContent[] = [];

  constructor(options: { maxDepth?: number } = {}) {
    this.#maxDepth = options.maxDepth ?? 5;
  }

  enqueue(sessionKey: string, label: string, message: string): BubbleContent | null {
    const bubble: BubbleContent = { sessionKey, label, message };

    if (this.#current === null) {
      this.#current = bubble;
      return bubble;
    }

    if (this.#current.sessionKey === sessionKey) {
      this.#current = bubble;
      return bubble;
    }

    const queueIdx = this.#queue.findIndex((b) => b.sessionKey === sessionKey);
    if (queueIdx !== -1) {
      this.#queue[queueIdx] = bubble;
    } else {
      this.#queue.push(bubble);
      if (this.#queue.length > this.#maxDepth - 1) {
        this.#queue.shift();
      }
    }
    return null;
  }

  dismiss(sessionKey: string): BubbleContent | null {
    if (this.#current?.sessionKey === sessionKey) {
      this.#current = this.#queue.shift() ?? null;
      return this.#current;
    }
    const idx = this.#queue.findIndex((b) => b.sessionKey === sessionKey);
    if (idx !== -1) this.#queue.splice(idx, 1);
    return null;
  }

  current(): BubbleContent | null {
    return this.#current;
  }
}
