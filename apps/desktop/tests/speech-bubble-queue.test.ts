import assert from "node:assert/strict";
import { SpeechBubbleQueue } from "../src/speech-bubble-queue.js";

// Empty queue: no current bubble, dismiss is a no-op.
{
  const q = new SpeechBubbleQueue();
  assert.equal(q.current(), null, "no current bubble when empty");
  assert.equal(q.dismiss("s1"), null, "dismiss on empty queue returns null");
}

// First enqueue becomes current immediately.
{
  const q = new SpeechBubbleQueue();
  const result = q.enqueue("s1", "fraud_project", "hello");
  assert.deepEqual(result, { sessionKey: "s1", label: "fraud_project", message: "hello" });
  assert.deepEqual(q.current(), { sessionKey: "s1", label: "fraud_project", message: "hello" });
}

// Same session replaces current immediately, even with a bubble queued behind it.
{
  const q = new SpeechBubbleQueue();
  q.enqueue("s1", "l1", "first");
  q.enqueue("s2", "l2", "queued"); // different session, queues
  const replaced = q.enqueue("s1", "l1", "second");
  assert.deepEqual(replaced, { sessionKey: "s1", label: "l1", message: "second" });
  assert.deepEqual(q.current(), { sessionKey: "s1", label: "l1", message: "second" });
}

// Different session queues: returns null, current stays unchanged.
{
  const q = new SpeechBubbleQueue();
  q.enqueue("s1", "l1", "first");
  const queued = q.enqueue("s2", "l2", "second");
  assert.equal(queued, null, "queuing a different session returns null");
  assert.deepEqual(q.current(), { sessionKey: "s1", label: "l1", message: "first" }, "current unchanged");
}

// Dismiss advances to the next queued bubble.
{
  const q = new SpeechBubbleQueue();
  q.enqueue("s1", "l1", "first");
  q.enqueue("s2", "l2", "second");
  q.enqueue("s3", "l3", "third");
  const next = q.dismiss("s1");
  assert.deepEqual(next, { sessionKey: "s2", label: "l2", message: "second" });
  assert.deepEqual(q.current(), { sessionKey: "s2", label: "l2", message: "second" });
  const after = q.dismiss("s2");
  assert.deepEqual(after, { sessionKey: "s3", label: "l3", message: "third" });
  const empty = q.dismiss("s3");
  assert.equal(empty, null, "dismissing the last bubble leaves queue empty");
  assert.equal(q.current(), null);
}

// Dismissing a session that is only queued (not current) removes it from the queue.
{
  const q = new SpeechBubbleQueue();
  q.enqueue("s1", "l1", "first");
  q.enqueue("s2", "l2", "second");
  q.enqueue("s3", "l3", "third");
  const result = q.dismiss("s2");
  assert.equal(result, null, "dismissing a queued (non-current) bubble returns null");
  assert.deepEqual(q.current(), { sessionKey: "s1", label: "l1", message: "first" }, "current unaffected");
  const next = q.dismiss("s1");
  assert.deepEqual(next, { sessionKey: "s3", label: "l3", message: "third" }, "s2 was removed from queue");
}

// Dismissing an unknown session key is a no-op.
{
  const q = new SpeechBubbleQueue();
  q.enqueue("s1", "l1", "first");
  const result = q.dismiss("unknown");
  assert.equal(result, null);
  assert.deepEqual(q.current(), { sessionKey: "s1", label: "l1", message: "first" });
}

// Updates a queued bubble in-place when the same session enqueues again.
{
  const q = new SpeechBubbleQueue();
  q.enqueue("s1", "l1", "first");
  q.enqueue("s2", "l2", "stale");
  const result = q.enqueue("s2", "l2", "fresh");
  assert.equal(result, null, "re-queuing still returns null (not current)");
  assert.deepEqual(q.current(), { sessionKey: "s1", label: "l1", message: "first" }, "current unaffected");
  q.dismiss("s1");
  assert.deepEqual(q.current(), { sessionKey: "s2", label: "l2", message: "fresh" }, "queued bubble was updated in-place, not duplicated");
}

// maxDepth bounds the queue: oldest queued bubble is dropped, current is never dropped.
{
  const q = new SpeechBubbleQueue({ maxDepth: 3 }); // current + 2 queued
  q.enqueue("s1", "l1", "current");
  q.enqueue("s2", "l2", "second");
  q.enqueue("s3", "l3", "third");
  q.enqueue("s4", "l4", "fourth"); // exceeds capacity, drops s2 (oldest queued)

  assert.deepEqual(q.current(), { sessionKey: "s1", label: "l1", message: "current" }, "current is never dropped");
  const afterFirstDismiss = q.dismiss("s1");
  assert.deepEqual(afterFirstDismiss, { sessionKey: "s3", label: "l3", message: "third" }, "s2 was dropped as the oldest queued entry");
  const afterSecondDismiss = q.dismiss("s3");
  assert.deepEqual(afterSecondDismiss, { sessionKey: "s4", label: "l4", message: "fourth" });
}

console.log("Speech bubble queue passed.");
