import type { MatrixInboundEvent } from "../types.js";
import type { ResolvedMatrixInboundRoute } from "./inbound.js";

export type MatrixInboundBatchDelivery = {
  route: ResolvedMatrixInboundRoute;
  events: MatrixInboundEvent[];
};

type PendingMatrixInboundBatch = {
  route: ResolvedMatrixInboundRoute;
  events: MatrixInboundEvent[];
  lastSeenAtMs: number;
};

type MatrixInboundBatcherOptions = {
  holdMs?: number;
  now?: () => number;
};

const DEFAULT_HOLD_MS = 900;

export class MatrixInboundBatcher {
  private readonly pendingBySession = new Map<string, PendingMatrixInboundBatch>();

  private readonly holdMs: number;

  private readonly now: () => number;

  constructor(opts?: MatrixInboundBatcherOptions) {
    this.holdMs = Number.isFinite(opts?.holdMs) ? Math.max(0, opts?.holdMs ?? 0) : DEFAULT_HOLD_MS;
    this.now = opts?.now ?? (() => Date.now());
  }

  push(params: {
    route: ResolvedMatrixInboundRoute;
    event: MatrixInboundEvent;
  }): MatrixInboundBatchDelivery[] {
    const nowMs = this.now();
    const ready = this.flushReady(nowMs);
    const sessionKey = params.route.sessionKey.trim();
    const pending = this.pendingBySession.get(sessionKey);

    if (!pending) {
      this.pendingBySession.set(sessionKey, {
        route: params.route,
        events: [params.event],
        lastSeenAtMs: nowMs,
      });
      return ready;
    }

    if (canAppendToPendingBatch(pending, params.event)) {
      pending.events.push(params.event);
      pending.route = params.route;
      pending.lastSeenAtMs = nowMs;
      return ready;
    }

    this.pendingBySession.delete(sessionKey);
    ready.push(finalizePendingBatch(pending));

    if (isDifferentSender(pending, params.event)) {
      ready.push({
        route: params.route,
        events: [params.event],
      });
      return ready;
    }

    this.pendingBySession.set(sessionKey, {
      route: params.route,
      events: [params.event],
      lastSeenAtMs: nowMs,
    });
    return ready;
  }

  flushReady(nowMs = this.now()): MatrixInboundBatchDelivery[] {
    const ready: MatrixInboundBatchDelivery[] = [];
    for (const [sessionKey, pending] of this.pendingBySession.entries()) {
      if (nowMs - pending.lastSeenAtMs < this.holdMs) {
        continue;
      }
      this.pendingBySession.delete(sessionKey);
      ready.push(finalizePendingBatch(pending));
    }
    return ready;
  }

  flushAll(): MatrixInboundBatchDelivery[] {
    const ready = [...this.pendingBySession.values()].map((pending) => finalizePendingBatch(pending));
    this.pendingBySession.clear();
    return ready;
  }
}

function finalizePendingBatch(pending: PendingMatrixInboundBatch): MatrixInboundBatchDelivery {
  return {
    route: pending.route,
    events: [...pending.events],
  };
}

function canAppendToPendingBatch(
  pending: PendingMatrixInboundBatch,
  event: MatrixInboundEvent,
): boolean {
  const first = pending.events[0];
  if (!first) {
    return false;
  }

  return (
    first.senderId === event.senderId &&
    first.roomId === event.roomId &&
    first.chatType === event.chatType &&
    (first.threadRootId?.trim() || "") === (event.threadRootId?.trim() || "")
  );
}

function isDifferentSender(
  pending: PendingMatrixInboundBatch,
  event: MatrixInboundEvent,
): boolean {
  return pending.events[0]?.senderId !== event.senderId;
}
