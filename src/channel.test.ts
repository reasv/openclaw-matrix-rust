import assert from "node:assert/strict";
import test from "node:test";

import { processNativeEvents } from "./channel.js";
import { buildMatrixHistoryScopeKey, createMatrixRoomHistoryBuffer } from "./matrix/history-buffer.js";
import {
  clearMatrixLatestInboundTracker,
  snapshotMatrixReplyProgress,
} from "./matrix/reply-policy.js";
import { MatrixSessionDispatcher } from "./matrix/session-dispatcher.js";
import { MatrixInboundBatcher } from "./matrix/inbound-batcher.js";
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createRoute(sessionKey: string) {
  return {
    agentId: "main",
    accountId: "default",
    mainSessionKey: "agent:main:main",
    parentSessionKey: sessionKey,
    sessionKey,
    lastRoutePolicy: "session" as const,
    isDirectMessage: false,
    roomConfigInfo: {
      allowed: false,
      allowlistConfigured: false,
    },
  };
}

test("processNativeEvents serializes inbound work for the same session key", async () => {
  const account = createAccount();
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const dispatcher = new MatrixSessionDispatcher();
  const releaseFirst = createDeferred<void>();
  const firstStarted = createDeferred<void>();
  const handledInbound: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const events: MatrixNativeEvent[] = [
    {
      type: "inbound",
      event: createInboundEvent("$first"),
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
    setStatus: () => undefined,
    client: {
      diagnostics: () => createDiagnostics(),
    } as any,
    cfg: {} as CoreConfig,
    inboundDispatcher: dispatcher,
    resolveInboundRoute: () => createRoute("agent:main:matrix:channel:!room:example.org"),
    handleInboundEvent: async ({ event }) => {
      handledInbound.push(`start:${event.eventId}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (event.eventId === "$first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      handledInbound.push(`end:${event.eventId}`);
      inFlight -= 1;
    },
  });

  await firstStarted.promise;
  assert.deepEqual(handledInbound, ["start:$first"]);
  assert.equal(dispatcher.getPendingCountForSession("agent:main:matrix:channel:!room:example.org"), 2);

  releaseFirst.resolve();
  await dispatcher.waitForIdle({ timeoutMs: 1_000 });

  assert.equal(maxInFlight, 1);
  assert.deepEqual(handledInbound, ["start:$first", "end:$first", "start:$second", "end:$second"]);
});

test("processNativeEvents updates reply progress before same-session work drains", async () => {
  clearMatrixLatestInboundTracker();
  const account = createAccount();
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const dispatcher = new MatrixSessionDispatcher();
  const releaseFirst = createDeferred<void>();
  const firstStarted = createDeferred<void>();

  const events: MatrixNativeEvent[] = [
    {
      type: "inbound",
      event: {
        ...createInboundEvent("$first"),
        timestamp: "2026-03-15T00:00:00.000Z",
      },
    },
    {
      type: "inbound",
      event: {
        ...createInboundEvent("$second"),
        timestamp: "2026-03-15T00:00:05.000Z",
      },
    },
  ];

  await processNativeEvents({
    events,
    account,
    roomHistory,
    setStatus: () => undefined,
    client: {
      diagnostics: () => createDiagnostics(),
    } as any,
    cfg: {} as CoreConfig,
    inboundDispatcher: dispatcher,
    resolveInboundRoute: () => createRoute("agent:main:matrix:channel:!room:example.org"),
    handleInboundEvent: async ({ event }) => {
      if (event.eventId === "$first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    },
  });

  await firstStarted.promise;
  assert.deepEqual(
    snapshotMatrixReplyProgress({
      scopeKey: buildMatrixHistoryScopeKey({
        accountId: account.accountId,
        roomId: "!room:example.org",
      }),
      currentEventId: "$first",
      currentTimestampMs: Date.parse("2026-03-15T00:00:00.000Z"),
    }),
    { newerNonselfExists: true },
  );

  releaseFirst.resolve();
  assert.equal(await dispatcher.waitForIdle({ timeoutMs: 1_000 }), true);
  clearMatrixLatestInboundTracker();
});

test("processNativeEvents runs different session keys in parallel", async () => {
  const account = createAccount();
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const dispatcher = new MatrixSessionDispatcher();
  const releaseBoth = createDeferred<void>();
  const started = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;

  const events: MatrixNativeEvent[] = [
    {
      type: "inbound",
      event: createInboundEvent("$first"),
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
    setStatus: () => undefined,
    client: {
      diagnostics: () => createDiagnostics(),
    } as any,
    cfg: {} as CoreConfig,
    inboundDispatcher: dispatcher,
    resolveInboundRoute: ({ event }) =>
      createRoute(
        event.eventId === "$first"
          ? "agent:main:matrix:channel:!room-a:example.org"
          : "agent:main:matrix:channel:!room-b:example.org",
      ),
    handleInboundEvent: async ({ event }) => {
      started.add(event.eventId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await releaseBoth.promise;
      inFlight -= 1;
    },
  });

  while (started.size < 2) {
    await Promise.resolve();
  }
  assert.equal(maxInFlight, 2);

  releaseBoth.resolve();
  assert.equal(await dispatcher.waitForIdle({ timeoutMs: 1_000 }), true);
});

test("processNativeEvents keeps draining after one inbound event fails", async () => {
  const account = createAccount();
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const dispatcher = new MatrixSessionDispatcher();
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
    inboundDispatcher: dispatcher,
    resolveInboundRoute: ({ event }) =>
      createRoute(
        event.eventId === "$first"
          ? "agent:main:matrix:channel:!room-a:example.org"
          : "agent:main:matrix:channel:!room-b:example.org",
      ),
    handleInboundEvent: async ({ event }) => {
      handledInbound.push(event.eventId);
      if (event.eventId === "$first") {
        throw new Error("boom");
      }
    },
  });

  assert.equal(await dispatcher.waitForIdle({ timeoutMs: 1_000 }), true);
  assert.deepEqual(handledInbound, ["$first", "$second"]);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.syncState, "ready");
  assert.ok(logs.includes("[matrix:default] sync_state=ready"));
  assert.ok(
    logs.some((message) =>
      /\[matrix:default\] native event failed \(room=!room:example\.org event=\$first\): Error: boom/.test(
        message,
      ),
    ),
  );
});

test("processNativeEvents batches consecutive same-sender events and dispatches the last as subject", async () => {
  const account = createAccount();
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const dispatcher = new MatrixSessionDispatcher();
  const handled: Array<{ eventId: string; previous: string[] }> = [];
  let nowMs = 0;
  const batcher = new MatrixInboundBatcher({
    holdMs: 500,
    now: () => nowMs,
  });

  await processNativeEvents({
    events: [
      {
        type: "inbound",
        event: createInboundEvent("$first"),
      },
      {
        type: "inbound",
        event: {
          ...createInboundEvent("$second"),
          body: "second",
        },
      },
    ],
    account,
    roomHistory,
    setStatus: () => undefined,
    client: {
      diagnostics: () => createDiagnostics(),
    } as any,
    cfg: {} as CoreConfig,
    inboundDispatcher: dispatcher,
    inboundBatcher: batcher,
    resolveInboundRoute: () => createRoute("agent:main:matrix:channel:!room:example.org"),
    handleInboundEvent: async ({ event, batchPreviousEvents }) => {
      handled.push({
        eventId: event.eventId,
        previous: (batchPreviousEvents ?? []).map((entry) => entry.eventId),
      });
    },
  });

  assert.equal(handled.length, 0);

  nowMs = 700;
  await processNativeEvents({
    events: [],
    account,
    roomHistory,
    setStatus: () => undefined,
    client: {
      diagnostics: () => createDiagnostics(),
    } as any,
    cfg: {} as CoreConfig,
    inboundDispatcher: dispatcher,
    inboundBatcher: batcher,
    resolveInboundRoute: () => createRoute("agent:main:matrix:channel:!room:example.org"),
    handleInboundEvent: async ({ event, batchPreviousEvents }) => {
      handled.push({
        eventId: event.eventId,
        previous: (batchPreviousEvents ?? []).map((entry) => entry.eventId),
      });
    },
  });

  assert.equal(await dispatcher.waitForIdle({ timeoutMs: 1_000 }), true);
  assert.deepEqual(handled, [
    {
      eventId: "$second",
      previous: ["$first"],
    },
  ]);
});

test("processNativeEvents flushes a sender batch before handling a different sender normally", async () => {
  const account = createAccount();
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const dispatcher = new MatrixSessionDispatcher();
  const handled: Array<{ eventId: string; previous: string[] }> = [];
  let nowMs = 0;
  const batcher = new MatrixInboundBatcher({
    holdMs: 500,
    now: () => nowMs,
  });

  await processNativeEvents({
    events: [
      {
        type: "inbound",
        event: createInboundEvent("$alice"),
      },
      {
        type: "inbound",
        event: {
          ...createInboundEvent("$bob"),
          senderId: "@bob:example.org",
          senderName: "Bob",
          body: "@bot hi",
        },
      },
    ],
    account,
    roomHistory,
    setStatus: () => undefined,
    client: {
      diagnostics: () => createDiagnostics(),
    } as any,
    cfg: {} as CoreConfig,
    inboundDispatcher: dispatcher,
    inboundBatcher: batcher,
    resolveInboundRoute: () => createRoute("agent:main:matrix:channel:!room:example.org"),
    handleInboundEvent: async ({ event, batchPreviousEvents }) => {
      handled.push({
        eventId: event.eventId,
        previous: (batchPreviousEvents ?? []).map((entry) => entry.eventId),
      });
    },
  });

  assert.equal(await dispatcher.waitForIdle({ timeoutMs: 1_000 }), true);
  assert.deepEqual(handled, [
    {
      eventId: "$alice",
      previous: [],
    },
    {
      eventId: "$bob",
      previous: [],
    },
  ]);
});
