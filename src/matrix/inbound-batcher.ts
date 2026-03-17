import type { MatrixInboundEvent } from "../types.js";
import type { ResolvedMatrixInboundRoute } from "./inbound.js";

export type MatrixInboundBatchDelivery = {
  route: ResolvedMatrixInboundRoute;
  events: MatrixInboundEvent[];
};

type MatrixInboundBatchLogContext = {
  accountId: string;
  log?: { debug?: (message: string) => void };
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
  }, logCtx?: MatrixInboundBatchLogContext): MatrixInboundBatchDelivery[] {
    const nowMs = this.now();
    const ready = this.flushReady(nowMs, logCtx);
    const sessionKey = params.route.sessionKey.trim();
    const pending = this.pendingBySession.get(sessionKey);

    if (!pending) {
      this.pendingBySession.set(sessionKey, {
        route: params.route,
        events: [params.event],
        lastSeenAtMs: nowMs,
      });
      logMatrixInboundBatch(logCtx, {
        action: "start",
        sessionKey,
        events: [params.event],
      });
      return ready;
    }

    if (canAppendToPendingBatch(pending, params.event)) {
      pending.events.push(params.event);
      pending.route = params.route;
      pending.lastSeenAtMs = nowMs;
      logMatrixInboundBatch(logCtx, {
        action: "append",
        sessionKey,
        events: pending.events,
      });
      return ready;
    }

    this.pendingBySession.delete(sessionKey);
    logMatrixInboundBatch(logCtx, {
      action: "flush",
      reason: isDifferentSender(pending, params.event) ? "sender-change" : "boundary-change",
      sessionKey,
      events: pending.events,
    });
    ready.push(finalizePendingBatch(pending));

    if (isDifferentSender(pending, params.event)) {
      logMatrixInboundBatch(logCtx, {
        action: "bypass",
        reason: "sender-change",
        sessionKey,
        events: [params.event],
      });
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
    logMatrixInboundBatch(logCtx, {
      action: "start",
      sessionKey,
      events: [params.event],
    });
    return ready;
  }

  flushReady(nowMs = this.now(), logCtx?: MatrixInboundBatchLogContext): MatrixInboundBatchDelivery[] {
    const ready: MatrixInboundBatchDelivery[] = [];
    for (const [sessionKey, pending] of this.pendingBySession.entries()) {
      if (nowMs - pending.lastSeenAtMs < this.holdMs) {
        continue;
      }
      this.pendingBySession.delete(sessionKey);
      logMatrixInboundBatch(logCtx, {
        action: "flush",
        reason: "timeout",
        sessionKey,
        events: pending.events,
      });
      ready.push(finalizePendingBatch(pending));
    }
    return ready;
  }

  flushAll(logCtx?: MatrixInboundBatchLogContext): MatrixInboundBatchDelivery[] {
    for (const [sessionKey, pending] of this.pendingBySession.entries()) {
      logMatrixInboundBatch(logCtx, {
        action: "flush",
        reason: "shutdown",
        sessionKey,
        events: pending.events,
      });
    }
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

function logMatrixInboundBatch(
  ctx: MatrixInboundBatchLogContext | undefined,
  params: {
    action: "start" | "append" | "flush" | "bypass";
    sessionKey: string;
    events: MatrixInboundEvent[];
    reason?: "timeout" | "shutdown" | "sender-change" | "boundary-change";
  },
): void {
  if (!ctx?.accountId) {
    return;
  }
  const first = params.events[0];
  const subject = params.events[params.events.length - 1];
  if (!first || !subject) {
    return;
  }
  const reason = params.reason ? ` reason=${params.reason}` : "";
  ctx.log?.debug?.(
    `[matrix:${ctx.accountId}] inbound batch ${params.action}${reason} session=${params.sessionKey} room=${subject.roomId} sender=${subject.senderId} size=${params.events.length} subject=${subject.eventId} first=${first.eventId}`,
  );
}
