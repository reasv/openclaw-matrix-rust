import assert from "node:assert/strict";
import test from "node:test";

import type { MatrixInboundEvent } from "../types.js";
import type { ResolvedMatrixInboundRoute } from "./inbound.js";
import { MatrixInboundBatcher } from "./inbound-batcher.js";

function createEvent(eventId: string, overrides: Partial<MatrixInboundEvent> = {}): MatrixInboundEvent {
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
    timestamp: "2026-03-17T00:00:00.000Z",
    media: [],
    ...overrides,
  };
}

function createRoute(sessionKey = "agent:main:matrix:channel:!room:example.org"): ResolvedMatrixInboundRoute {
  return {
    agentId: "main",
    accountId: "default",
    mainSessionKey: "agent:main:main",
    parentSessionKey: sessionKey,
    sessionKey,
    lastRoutePolicy: "session",
    isDirectMessage: false,
    roomConfigInfo: {
      allowed: true,
      allowlistConfigured: false,
    },
  };
}

test("keeps consecutive same-sender events pending until the hold window elapses", () => {
  let nowMs = 0;
  const batcher = new MatrixInboundBatcher({
    holdMs: 500,
    now: () => nowMs,
  });
  const route = createRoute();

  assert.deepEqual(batcher.push({ route, event: createEvent("$first") }), []);

  nowMs = 100;
  assert.deepEqual(
    batcher.push({
      route,
      event: createEvent("$second", {
        body: "follow up",
      }),
    }),
    [],
  );

  nowMs = 700;
  const flushed = batcher.flushReady();
  assert.equal(flushed.length, 1);
  assert.deepEqual(
    flushed[0]?.events.map((entry) => entry.eventId),
    ["$first", "$second"],
  );
});

test("emits debug logs for batch lifecycle events", () => {
  let nowMs = 0;
  const batcher = new MatrixInboundBatcher({
    holdMs: 500,
    now: () => nowMs,
  });
  const route = createRoute();
  const logs: string[] = [];
  const logCtx = {
    accountId: "default",
    log: {
      debug: (message: string) => {
        logs.push(message);
      },
    },
  };

  batcher.push({ route, event: createEvent("$first") }, logCtx);

  nowMs = 100;
  batcher.push({ route, event: createEvent("$second") }, logCtx);

  nowMs = 700;
  batcher.flushReady(undefined, logCtx);

  assert.match(
    logs[0] ?? "",
    /\[matrix:default\] inbound batch start session=agent:main:matrix:channel:!room:example\.org room=!room:example\.org sender=@alice:example\.org size=1 subject=\$first first=\$first/,
  );
  assert.match(
    logs[1] ?? "",
    /\[matrix:default\] inbound batch append session=agent:main:matrix:channel:!room:example\.org room=!room:example\.org sender=@alice:example\.org size=2 subject=\$second first=\$first/,
  );
  assert.match(
    logs[2] ?? "",
    /\[matrix:default\] inbound batch flush reason=timeout session=agent:main:matrix:channel:!room:example\.org room=!room:example\.org sender=@alice:example\.org size=2 subject=\$second first=\$first/,
  );
});

test("flushes the pending batch when a different sender appears and forwards that sender immediately", () => {
  let nowMs = 0;
  const batcher = new MatrixInboundBatcher({
    holdMs: 500,
    now: () => nowMs,
  });
  const route = createRoute();

  batcher.push({ route, event: createEvent("$first") });

  nowMs = 100;
  const deliveries = batcher.push({
    route,
    event: createEvent("$other", {
      senderId: "@bob:example.org",
      senderName: "Bob",
      body: "@bot hi",
    }),
  });

  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[0]?.events.map((entry) => entry.eventId), ["$first"]);
  assert.deepEqual(deliveries[1]?.events.map((entry) => entry.eventId), ["$other"]);
});

test("logs sender-change flushes and bypass delivery", () => {
  let nowMs = 0;
  const batcher = new MatrixInboundBatcher({
    holdMs: 500,
    now: () => nowMs,
  });
  const route = createRoute();
  const logs: string[] = [];
  const logCtx = {
    accountId: "default",
    log: {
      debug: (message: string) => {
        logs.push(message);
      },
    },
  };

  batcher.push({ route, event: createEvent("$first") }, logCtx);

  nowMs = 100;
  batcher.push(
    {
      route,
      event: createEvent("$other", {
        senderId: "@bob:example.org",
        senderName: "Bob",
      }),
    },
    logCtx,
  );

  assert.match(logs[1] ?? "", /inbound batch flush reason=sender-change .* subject=\$first /);
  assert.match(logs[2] ?? "", /inbound batch bypass reason=sender-change .* subject=\$other /);
});

test("keeps separate thread sessions in independent pending batches", () => {
  let nowMs = 0;
  const batcher = new MatrixInboundBatcher({
    holdMs: 500,
    now: () => nowMs,
  });
  const route = createRoute("agent:main:matrix:channel:!room:example.org:thread:$one");

  batcher.push({
    route,
    event: createEvent("$first", {
      threadRootId: "$one",
    }),
  });

  nowMs = 100;
  const deliveries = batcher.push({
    route: createRoute("agent:main:matrix:channel:!room:example.org:thread:$two"),
    event: createEvent("$second", {
      threadRootId: "$two",
    }),
  });
  assert.deepEqual(deliveries, []);

  nowMs = 700;
  const later = batcher.flushReady();
  assert.deepEqual(later.map((delivery) => delivery.events.map((entry) => entry.eventId)), [
    ["$first"],
    ["$second"],
  ]);
});
