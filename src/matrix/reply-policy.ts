export type MatrixReplyPolicyScope = "dm" | "room" | "thread";

export type MatrixReplyDispatchKind = "tool" | "block" | "final";

export type MatrixReplyPayload = {
  text?: string;
  body?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
};

export type MatrixReplyPosition = "only" | "first" | "middle" | "last";

export type MatrixReplyProgressSnapshot = {
  newerNonselfExists: boolean;
};

type PendingFinal = {
  payload: MatrixReplyPayload;
};

type ReplyTargetKind = "none" | "current" | "explicit_other";

export type MatrixReplyPolicyController = {
  deliver: (payload: MatrixReplyPayload, kind: MatrixReplyDispatchKind) => Promise<void>;
  flushPendingFinal: () => Promise<void>;
  getState: () => {
    responseMessageCount: number;
    pendingFinal: boolean;
  };
};

export function classifyReplyTargetKind(
  payload: MatrixReplyPayload,
  currentEventId: string,
): ReplyTargetKind {
  const replyToId = payload.replyToId?.trim();
  if (!replyToId) {
    return "none";
  }
  return replyToId === currentEventId ? "current" : "explicit_other";
}

function clearReplyToId(payload: MatrixReplyPayload): MatrixReplyPayload {
  if (!payload.replyToId) {
    return payload;
  }
  return {
    ...payload,
    replyToId: undefined,
  };
}

function setCurrentReplyToId(
  payload: MatrixReplyPayload,
  currentEventId: string,
): MatrixReplyPayload {
  if (payload.replyToId === currentEventId) {
    return payload;
  }
  return {
    ...payload,
    replyToId: currentEventId,
  };
}

export function applyMatrixReplyHeuristic(params: {
  payload: MatrixReplyPayload;
  scope: MatrixReplyPolicyScope;
  currentEventId: string;
  position: MatrixReplyPosition;
  newerNonselfExists: boolean;
  elapsedMs: number;
  wakeThresholdMs?: number;
}): MatrixReplyPayload {
  const targetKind = classifyReplyTargetKind(params.payload, params.currentEventId);
  if (targetKind === "explicit_other") {
    return params.payload;
  }
  if (params.scope === "dm") {
    return clearReplyToId(params.payload);
  }

  const shouldAnchorCurrent =
    params.position === "middle"
      ? false
      : params.position === "last"
        ? params.newerNonselfExists ||
          params.elapsedMs > (params.wakeThresholdMs ?? 30_000)
        : params.newerNonselfExists;

  return shouldAnchorCurrent
    ? setCurrentReplyToId(params.payload, params.currentEventId)
    : clearReplyToId(params.payload);
}

export function createMatrixReplyPolicyController(params: {
  scope: MatrixReplyPolicyScope;
  currentEventId: string;
  currentTimestampMs: number;
  deliverNow: (payload: MatrixReplyPayload) => Promise<void>;
  getProgress: () => MatrixReplyProgressSnapshot;
  now?: () => number;
  wakeThresholdMs?: number;
}): MatrixReplyPolicyController {
  let responseMessageCount = 0;
  let pendingFinal: PendingFinal | null = null;

  const sendPositioned = async (
    payload: MatrixReplyPayload,
    position: MatrixReplyPosition,
  ): Promise<void> => {
    const progress = params.getProgress();
    const nowMs = params.now?.() ?? Date.now();
    const resolved = applyMatrixReplyHeuristic({
      payload,
      scope: params.scope,
      currentEventId: params.currentEventId,
      position,
      newerNonselfExists: progress.newerNonselfExists,
      elapsedMs: Math.max(0, nowMs - params.currentTimestampMs),
      wakeThresholdMs: params.wakeThresholdMs,
    });
    await params.deliverNow(resolved);
    responseMessageCount += 1;
  };

  const sendAux = async (payload: MatrixReplyPayload): Promise<void> => {
    const targetKind = classifyReplyTargetKind(payload, params.currentEventId);
    const resolved = targetKind === "explicit_other" ? payload : clearReplyToId(payload);
    await params.deliverNow(resolved);
  };

  return {
    async deliver(payload, kind) {
      if (kind === "tool") {
        await sendAux(payload);
        return;
      }
      if (kind === "block") {
        await sendPositioned(payload, responseMessageCount === 0 ? "first" : "middle");
        return;
      }
      if (!pendingFinal) {
        pendingFinal = { payload };
        return;
      }
      await sendPositioned(pendingFinal.payload, responseMessageCount === 0 ? "first" : "middle");
      pendingFinal = { payload };
    },
    async flushPendingFinal() {
      if (!pendingFinal) {
        return;
      }
      const position: MatrixReplyPosition = responseMessageCount === 0 ? "only" : "last";
      const payload = pendingFinal.payload;
      pendingFinal = null;
      await sendPositioned(payload, position);
    },
    getState() {
      return {
        responseMessageCount,
        pendingFinal: pendingFinal !== null,
      };
    },
  };
}

type MatrixLatestInboundEvent = {
  eventId: string;
  timestampMs: number;
};

const latestInboundByScope = new Map<string, MatrixLatestInboundEvent>();

export function clearMatrixLatestInboundTracker(): void {
  latestInboundByScope.clear();
}

export function recordMatrixLatestInboundEvent(params: {
  scopeKey: string;
  eventId: string;
  timestampMs: number;
}): void {
  const scopeKey = params.scopeKey.trim();
  if (!scopeKey || !Number.isFinite(params.timestampMs)) {
    return;
  }
  const existing = latestInboundByScope.get(scopeKey);
  if (
    existing &&
    (existing.timestampMs > params.timestampMs ||
      (existing.timestampMs === params.timestampMs && existing.eventId === params.eventId))
  ) {
    return;
  }
  latestInboundByScope.set(scopeKey, {
    eventId: params.eventId,
    timestampMs: params.timestampMs,
  });
}

export function snapshotMatrixReplyProgress(params: {
  scopeKey: string;
  currentEventId: string;
  currentTimestampMs: number;
}): MatrixReplyProgressSnapshot {
  const scopeKey = params.scopeKey.trim();
  if (!scopeKey || !Number.isFinite(params.currentTimestampMs)) {
    return { newerNonselfExists: false };
  }
  const latest = latestInboundByScope.get(scopeKey);
  if (!latest) {
    return { newerNonselfExists: false };
  }
  return {
    newerNonselfExists:
      latest.timestampMs > params.currentTimestampMs && latest.eventId !== params.currentEventId,
  };
}
