import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMatrixFlushedEventKey,
  clearMatrixFlushedEventDedupes,
  hasMatrixFlushedEvent,
  markMatrixEventsFlushed,
  resolveMatrixFlushedEventDedupeFilePath,
} from "./flushed-event-dedupe.js";

function createRuntime(stateDir: string) {
  return {
    state: {
      resolveStateDir: () => stateDir,
    },
  } as any;
}

test("buildMatrixFlushedEventKey normalizes room and event ids", () => {
  assert.equal(
    buildMatrixFlushedEventKey({
      roomId: " !room:example.org ",
      eventId: " $event ",
    }),
    "!room:example.org:$event",
  );
  assert.equal(
    buildMatrixFlushedEventKey({
      roomId: " ",
      eventId: "$event",
    }),
    "",
  );
});

test("markMatrixEventsFlushed persists dedupe markers without message bodies", async () => {
  clearMatrixFlushedEventDedupes();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-rust-dedupe-"));
  const runtime = createRuntime(stateDir);

  await markMatrixEventsFlushed({
    runtime,
    accountId: "Work",
    events: [
      { roomId: "!room:example.org", eventId: "$first" },
      { roomId: "!room:example.org", eventId: "$second" },
    ],
  });

  const filePath = resolveMatrixFlushedEventDedupeFilePath({
    runtime,
    accountId: "work",
  });
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  assert.equal(typeof parsed["!room:example.org:$first"], "number");
  assert.equal(typeof parsed["!room:example.org:$second"], "number");
  assert.deepEqual(Object.keys(parsed).sort(), [
    "!room:example.org:$first",
    "!room:example.org:$second",
  ]);
  assert.equal(
    await hasMatrixFlushedEvent({
      runtime,
      accountId: "work",
      event: { roomId: "!room:example.org", eventId: "$second" },
    }),
    true,
  );
});
