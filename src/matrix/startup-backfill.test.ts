import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backfillMatrixRoomHistory,
  matrixMessageSummaryToInboundEvent,
  resolveMatrixStartupBackfillLimit,
  resolveMatrixStartupBackfillTargets,
} from "./startup-backfill.js";
import { clearMatrixFlushedEventDedupes, markMatrixEventsFlushed } from "./flushed-event-dedupe.js";
import { createMatrixRoomHistoryBuffer } from "./history-buffer.js";
import type {
  CoreConfig,
  MatrixMessageSummary,
  ResolvedMatrixAccount,
} from "../types.js";

function createAccount(
  config: Partial<ResolvedMatrixAccount["config"]> = {},
): ResolvedMatrixAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    authMode: "password",
    config: {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "secret",
      ...config,
    },
  };
}

function createRuntime(stateDir: string) {
  return {
    state: {
      resolveStateDir: () => stateDir,
    },
  } as any;
}

function createSummary(
  eventId: string,
  timestamp: string,
  overrides: Partial<MatrixMessageSummary> = {},
): MatrixMessageSummary {
  return {
    eventId,
    sender: "@alice:example.org",
    body: eventId,
    timestamp,
    ...overrides,
  };
}

test("resolveMatrixStartupBackfillTargets trims entries and ignores wildcard rooms", () => {
  const account = createAccount({
    rooms: {
      " !room:example.org ": {},
      "*": {},
      "#ops:example.org": {},
    },
  });

  assert.deepEqual(resolveMatrixStartupBackfillTargets(account), [
    "!room:example.org",
    "#ops:example.org",
  ]);
});

test("resolveMatrixStartupBackfillLimit caps startup replay at ten messages", () => {
  assert.equal(resolveMatrixStartupBackfillLimit(createAccount({ roomHistoryMaxEntries: 50 })), 10);
  assert.equal(resolveMatrixStartupBackfillLimit(createAccount({ roomHistoryMaxEntries: 4 })), 4);
  assert.equal(resolveMatrixStartupBackfillLimit(createAccount({ roomHistoryMaxEntries: 0 })), 0);
});

test("matrixMessageSummaryToInboundEvent preserves reply and thread metadata", () => {
  assert.deepEqual(
    matrixMessageSummaryToInboundEvent({
      roomId: "!room:example.org",
      summary: createSummary("$reply", "2026-03-15T11:58:00.000Z", {
        relatesTo: {
          eventId: "$root",
        },
      }),
    }),
    {
      roomId: "!room:example.org",
      eventId: "$reply",
      senderId: "@alice:example.org",
      chatType: "channel",
      body: "$reply",
      msgtype: undefined,
      replyToId: "$root",
      threadRootId: undefined,
      timestamp: "2026-03-15T11:58:00.000Z",
      media: [],
    },
  );

  assert.deepEqual(
    matrixMessageSummaryToInboundEvent({
      roomId: "!room:example.org",
      summary: createSummary("$thread", "2026-03-15T11:59:00.000Z", {
        relatesTo: {
          relType: "m.thread",
          eventId: "$root",
        },
      }),
    }),
    {
      roomId: "!room:example.org",
      eventId: "$thread",
      senderId: "@alice:example.org",
      chatType: "thread",
      body: "$thread",
      msgtype: undefined,
      replyToId: undefined,
      threadRootId: "$root",
      timestamp: "2026-03-15T11:59:00.000Z",
      media: [],
    },
  );
});

test("backfillMatrixRoomHistory replays only unflushed pre-start messages oldest first", async () => {
  clearMatrixFlushedEventDedupes();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-rust-backfill-"));
  const runtime = createRuntime(stateDir);
  const handled: Array<{ eventId: string; skipStartupGrace: boolean | undefined }> = [];
  const reads: Array<{ roomId: string; limit?: number }> = [];

  await markMatrixEventsFlushed({
    runtime,
    accountId: "default",
    events: [{ roomId: "!room:example.org", eventId: "$flushed" }],
  });

  await backfillMatrixRoomHistory({
    account: createAccount({
      roomHistoryMaxEntries: 25,
      rooms: {
        "!room:example.org": {},
      },
    }),
    client: {
      diagnostics: () => ({
        startedAt: "2026-03-15T12:00:00.000Z",
      }),
      readMessages: ({ roomId, limit }: { roomId: string; limit?: number }) => {
        reads.push({ roomId, limit });
        return {
          messages: [
            createSummary("$after-start", "2026-03-15T12:00:01.000Z"),
            createSummary("$late", "2026-03-15T11:59:30.000Z"),
            createSummary("$flushed", "2026-03-15T11:58:30.000Z"),
            createSummary("$early", "2026-03-15T11:57:30.000Z"),
          ],
        };
      },
    } as any,
    roomHistory: createMatrixRoomHistoryBuffer(5),
    runtime,
    cfg: {} as CoreConfig,
    handleInboundEvent: async (params) => {
      handled.push({
        eventId: params.event.eventId,
        skipStartupGrace: params.skipStartupGrace,
      });
    },
  });

  assert.deepEqual(reads, [{ roomId: "!room:example.org", limit: 10 }]);
  assert.deepEqual(handled, [
    { eventId: "$early", skipStartupGrace: true },
    { eventId: "$late", skipStartupGrace: true },
  ]);
});

test("backfillMatrixRoomHistory continues after room reads and event handling fail", async () => {
  clearMatrixFlushedEventDedupes();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-rust-backfill-errors-"));
  const logs: string[] = [];
  const handled: string[] = [];

  await backfillMatrixRoomHistory({
    account: createAccount({
      rooms: {
        "!broken:example.org": {},
        "!ok:example.org": {},
      },
    }),
    client: {
      diagnostics: () => ({
        startedAt: "2026-03-15T12:00:00.000Z",
      }),
      readMessages: ({ roomId }: { roomId: string }) => {
        if (roomId === "!broken:example.org") {
          throw new Error("room fetch failed");
        }
        return {
          messages: [
            createSummary("$bad", "2026-03-15T11:58:00.000Z"),
            createSummary("$good", "2026-03-15T11:59:00.000Z"),
          ],
        };
      },
    } as any,
    roomHistory: createMatrixRoomHistoryBuffer(5),
    runtime: createRuntime(stateDir),
    cfg: {} as CoreConfig,
    log: {
      info: (message) => {
        logs.push(message);
      },
    },
    handleInboundEvent: async ({ event }) => {
      handled.push(event.eventId);
      if (event.eventId === "$bad") {
        throw new Error("boom");
      }
    },
  });

  assert.deepEqual(handled, ["$bad", "$good"]);
  assert.match(
    logs[0] ?? "",
    /\[matrix:default\] startup backfill read failed for !broken:example\.org: Error: room fetch failed/,
  );
  assert.match(
    logs[1] ?? "",
    /\[matrix:default\] startup backfill event failed \(!ok:example\.org \$bad\): Error: boom/,
  );
});
