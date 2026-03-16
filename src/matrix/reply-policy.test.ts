import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMatrixReplyHeuristic,
  clearMatrixLatestInboundTracker,
  classifyReplyTargetKind,
  createMatrixReplyPolicyController,
  recordMatrixLatestInboundEvent,
  snapshotMatrixReplyProgress,
  type MatrixReplyPayload,
} from "./reply-policy.js";

test("classifyReplyTargetKind distinguishes current and explicit older targets", () => {
  assert.equal(classifyReplyTargetKind({}, "$current"), "none");
  assert.equal(classifyReplyTargetKind({ replyToId: "$current" }, "$current"), "current");
  assert.equal(classifyReplyTargetKind({ replyToId: "$older" }, "$current"), "explicit_other");
});

test("applyMatrixReplyHeuristic always preserves explicit non-current targets", () => {
  const payload = { text: "hello", replyToId: "$older" };
  const result = applyMatrixReplyHeuristic({
    payload,
    scope: "dm",
    currentEventId: "$current",
    position: "middle",
    newerNonselfExists: false,
    elapsedMs: 0,
  });
  assert.deepEqual(result, payload);
});

test("applyMatrixReplyHeuristic strips current replies in DMs", () => {
  const result = applyMatrixReplyHeuristic({
    payload: { text: "hello", replyToId: "$current" },
    scope: "dm",
    currentEventId: "$current",
    position: "only",
    newerNonselfExists: true,
    elapsedMs: 60_000,
  });
  assert.equal(result.replyToId, undefined);
});

test("applyMatrixReplyHeuristic adds current reply for first room message when room advanced", () => {
  const result = applyMatrixReplyHeuristic({
    payload: { text: "working" },
    scope: "room",
    currentEventId: "$current",
    position: "first",
    newerNonselfExists: true,
    elapsedMs: 500,
  });
  assert.equal(result.replyToId, "$current");
});

test("applyMatrixReplyHeuristic strips current reply for middle room messages", () => {
  const result = applyMatrixReplyHeuristic({
    payload: { text: "step 2", replyToId: "$current" },
    scope: "room",
    currentEventId: "$current",
    position: "middle",
    newerNonselfExists: true,
    elapsedMs: 500,
  });
  assert.equal(result.replyToId, undefined);
});

test("applyMatrixReplyHeuristic adds current reply for late final room message", () => {
  const result = applyMatrixReplyHeuristic({
    payload: { text: "done" },
    scope: "room",
    currentEventId: "$current",
    position: "last",
    newerNonselfExists: false,
    elapsedMs: 31_000,
  });
  assert.equal(result.replyToId, "$current");
});

test("reply policy controller uses rolling one-final buffer", async () => {
  const delivered: MatrixReplyPayload[] = [];
  const controller = createMatrixReplyPolicyController({
    scope: "room",
    currentEventId: "$current",
    currentTimestampMs: 100,
    now: () => 100,
    getProgress: () => ({ newerNonselfExists: false }),
    deliverNow: async (payload) => {
      delivered.push(payload);
    },
  });

  await controller.deliver({ text: "a", replyToId: "$current" }, "final");
  assert.deepEqual(delivered, []);
  assert.deepEqual(controller.getState(), {
    responseMessageCount: 0,
    pendingFinal: true,
  });

  await controller.deliver({ text: "b", replyToId: "$current" }, "final");
  assert.deepEqual(delivered, [{ text: "a", replyToId: undefined }]);

  await controller.flushPendingFinal();
  assert.deepEqual(delivered, [
    { text: "a", replyToId: undefined },
    { text: "b", replyToId: undefined },
  ]);
});

test("reply policy controller preserves explicit non-current reply targets in final flush", async () => {
  const delivered: MatrixReplyPayload[] = [];
  const controller = createMatrixReplyPolicyController({
    scope: "room",
    currentEventId: "$current",
    currentTimestampMs: 100,
    now: () => 100,
    getProgress: () => ({ newerNonselfExists: false }),
    deliverNow: async (payload) => {
      delivered.push(payload);
    },
  });

  await controller.deliver({ text: "done", replyToId: "$older" }, "final");
  await controller.flushPendingFinal();

  assert.deepEqual(delivered, [{ text: "done", replyToId: "$older" }]);
});

test("reply policy controller strips current replies from tool payloads", async () => {
  const delivered: MatrixReplyPayload[] = [];
  const controller = createMatrixReplyPolicyController({
    scope: "room",
    currentEventId: "$current",
    currentTimestampMs: 100,
    now: () => 100,
    getProgress: () => ({ newerNonselfExists: true }),
    deliverNow: async (payload) => {
      delivered.push(payload);
    },
  });

  await controller.deliver({ text: "tool status", replyToId: "$current" }, "tool");

  assert.deepEqual(delivered, [{ text: "tool status", replyToId: undefined }]);
});

test("snapshotMatrixReplyProgress tracks newer non-self inbound events per scope", () => {
  clearMatrixLatestInboundTracker();
  recordMatrixLatestInboundEvent({
    scopeKey: "default:!room:example.org",
    eventId: "$current",
    timestampMs: 100,
  });
  assert.deepEqual(
    snapshotMatrixReplyProgress({
      scopeKey: "default:!room:example.org",
      currentEventId: "$current",
      currentTimestampMs: 100,
    }),
    { newerNonselfExists: false },
  );

  recordMatrixLatestInboundEvent({
    scopeKey: "default:!room:example.org",
    eventId: "$newer",
    timestampMs: 200,
  });
  assert.deepEqual(
    snapshotMatrixReplyProgress({
      scopeKey: "default:!room:example.org",
      currentEventId: "$current",
      currentTimestampMs: 100,
    }),
    { newerNonselfExists: true },
  );
});
