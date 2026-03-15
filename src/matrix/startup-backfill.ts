import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import type { CoreConfig, MatrixMessageSummary, ResolvedMatrixAccount } from "../types.js";
import type { MatrixNativeClient } from "./adapter/native-client.js";
import { hasMatrixFlushedEvent } from "./flushed-event-dedupe.js";
import { resolveMatrixRoomHistoryMaxEntries, type MatrixRoomHistoryBuffer } from "./history-buffer.js";
import { handleMatrixInboundEvent } from "./inbound.js";

const MAX_STARTUP_BACKFILL_MESSAGES = 10;

export function resolveMatrixStartupBackfillTargets(account: ResolvedMatrixAccount): string[] {
  const targets = Object.keys(account.config.rooms ?? account.config.groups ?? {})
    .map((value) => value.trim())
    .filter((value) => Boolean(value) && value !== "*");
  return [...new Set(targets)];
}

export function resolveMatrixStartupBackfillLimit(account: ResolvedMatrixAccount): number {
  const roomHistoryMaxEntries = resolveMatrixRoomHistoryMaxEntries(account.config.roomHistoryMaxEntries);
  return Math.min(roomHistoryMaxEntries, MAX_STARTUP_BACKFILL_MESSAGES);
}

export function matrixMessageSummaryToInboundEvent(params: {
  summary: MatrixMessageSummary;
  roomId: string;
}): {
  roomId: string;
  eventId: string;
  senderId: string;
  chatType: "channel" | "thread";
  body: string;
  msgtype?: string;
  replyToId?: string;
  threadRootId?: string;
  timestamp: string;
  media: [];
} {
  const relatesTo = params.summary.relatesTo;
  const isThread = relatesTo?.relType === "m.thread";
  return {
    roomId: params.roomId,
    eventId: params.summary.eventId,
    senderId: params.summary.sender,
    chatType: isThread ? "thread" : "channel",
    body: params.summary.body,
    msgtype: params.summary.msgtype,
    replyToId: isThread ? undefined : relatesTo?.eventId,
    threadRootId: isThread ? relatesTo?.eventId : undefined,
    timestamp: params.summary.timestamp,
    media: [],
  };
}

export async function backfillMatrixRoomHistory(params: {
  account: ResolvedMatrixAccount;
  client: Pick<MatrixNativeClient, "diagnostics" | "readMessages">;
  roomHistory: MatrixRoomHistoryBuffer;
  runtime: PluginRuntime;
  cfg: CoreConfig;
  log?: { info?: (message: string) => void; debug?: (message: string) => void };
  handleInboundEvent?: typeof handleMatrixInboundEvent;
}): Promise<void> {
  const limit = resolveMatrixStartupBackfillLimit(params.account);
  if (limit <= 0) {
    return;
  }

  const targets = resolveMatrixStartupBackfillTargets(params.account);
  if (targets.length === 0) {
    return;
  }

  const handleInboundEvent = params.handleInboundEvent ?? handleMatrixInboundEvent;
  const startedAt = Date.parse(params.client.diagnostics().startedAt ?? "");

  for (const roomId of targets) {
    let messages: MatrixMessageSummary[] = [];
    try {
      messages = params.client.readMessages({
        roomId,
        limit,
      }).messages;
    } catch (err) {
      params.log?.info?.(
        `[matrix:${params.account.accountId}] startup backfill read failed for ${roomId}: ${String(err)}`,
      );
      continue;
    }

    const ordered = [...messages]
      .filter((summary) => {
        const timestamp = Date.parse(summary.timestamp);
        if (!Number.isFinite(startedAt) || !Number.isFinite(timestamp)) {
          return true;
        }
        return timestamp < startedAt;
      })
      .sort(
        (left: MatrixMessageSummary, right: MatrixMessageSummary) =>
          Date.parse(left.timestamp) - Date.parse(right.timestamp),
      );

    for (const summary of ordered) {
      if (
        await hasMatrixFlushedEvent({
          runtime: params.runtime,
          accountId: params.account.accountId,
          event: {
            roomId,
            eventId: summary.eventId,
          },
        })
      ) {
        continue;
      }

      try {
        await handleInboundEvent({
          cfg: params.cfg,
          account: params.account,
          client: params.client as MatrixNativeClient,
          event: matrixMessageSummaryToInboundEvent({
            summary,
            roomId,
          }),
          roomHistory: params.roomHistory,
          log: params.log,
          skipStartupGrace: true,
        });
      } catch (err) {
        params.log?.info?.(
          `[matrix:${params.account.accountId}] startup backfill event failed (${roomId} ${summary.eventId}): ${String(err)}`,
        );
      }
    }
  }
}
