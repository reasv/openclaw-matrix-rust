import assert from "node:assert/strict";
import test from "node:test";

import { processNativeEvents } from "./channel.js";
import { createMatrixRoomHistoryBuffer } from "./matrix/history-buffer.js";
import type {
  CoreConfig,
  MatrixInboundEvent,
  MatrixNativeDiagnostics,
  MatrixNativeEvent,
  ResolvedMatrixAccount,
} from "./types.js";

function createAccount(): ResolvedMatrixAccount {
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
    },
  };
}

function createInboundEvent(eventId: string): MatrixInboundEvent {
  return {
    roomId: "!room:example.org",
    eventId,
    senderId: "@alice:example.org",
    senderName: "Alice",
    roomName: "Dev Room",
    roomAlias: "#dev:example.org",
    chatType: "channel",
    body: "hello",
    msgtype: "m.text",
    timestamp: "2026-03-15T00:00:00.000Z",
    media: [],
  };
}

function createDiagnostics(): MatrixNativeDiagnostics {
  return {
    accountId: "default",
    userId: "@bot:example.org",
    deviceId: "DEVICE",
    verificationState: "verified",
    keyBackupState: "enabled",
    syncState: "ready",
    lastSuccessfulSyncAt: "2026-03-15T00:00:00.000Z",
    lastSuccessfulDecryptionAt: "2026-03-15T00:00:00.000Z",
    startedAt: "2026-03-15T00:00:00.000Z",
  };
}

test("processNativeEvents keeps draining after one inbound event fails", async () => {
  const account = createAccount();
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const logs: string[] = [];
  const statuses: Array<Record<string, unknown>> = [];
  const handledInbound: string[] = [];

  const events: MatrixNativeEvent[] = [
    {
      type: "inbound",
      event: createInboundEvent("$first"),
    },
    {
      type: "sync_state",
      state: "ready",
      at: "2026-03-15T00:00:01.000Z",
    },
    {
      type: "inbound",
      event: createInboundEvent("$second"),
    },
  ];

  await processNativeEvents({
    events,
    account,
    roomHistory,
    log: {
      info: (message) => {
        logs.push(message);
      },
    },
    setStatus: (next) => {
      statuses.push(next);
    },
    client: {
      diagnostics: () => createDiagnostics(),
    } as any,
    cfg: {} as CoreConfig,
    handleInboundEvent: async ({ event }) => {
      handledInbound.push(event.eventId);
      if (event.eventId === "$first") {
        throw new Error("boom");
      }
    },
  });

  assert.deepEqual(handledInbound, ["$first", "$second"]);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.syncState, "ready");
  assert.match(
    logs[0] ?? "",
    /\[matrix:default\] native event failed \(room=!room:example\.org event=\$first\): Error: boom/,
  );
  assert.equal(logs[1], "[matrix:default] sync_state=ready");
});
