import fs from "node:fs/promises";
import path from "node:path";
import { createPersistentDedupe } from "openclaw/plugin-sdk";
import {
  normalizeAccountId,
  type PluginRuntime,
} from "openclaw/plugin-sdk/matrix";
import type { PersistentDedupe } from "openclaw/plugin-sdk";

const FLUSHED_EVENT_NAMESPACE = "flushed-events";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_SIZE = 20_000;
const DEFAULT_FILE_MAX_ENTRIES = 50_000;

const activeDedupes = new Map<string, PersistentDedupe>();

export type MatrixFlushedEventRef = {
  roomId: string;
  eventId: string;
};

function normalizeValue(value: string): string {
  return value.trim();
}

function buildDedupeMapKey(params: {
  runtime: PluginRuntime;
  accountId: string;
}): string {
  return `${params.runtime.state.resolveStateDir()}:${normalizeAccountId(params.accountId)}`;
}

export function buildMatrixFlushedEventKey(params: MatrixFlushedEventRef): string {
  const roomId = normalizeValue(params.roomId);
  const eventId = normalizeValue(params.eventId);
  if (!roomId || !eventId) {
    return "";
  }
  return `${roomId}:${eventId}`;
}

export function resolveMatrixFlushedEventDedupeFilePath(params: {
  runtime: PluginRuntime;
  accountId: string;
}): string {
  const stateDir = params.runtime.state.resolveStateDir();
  const accountId = normalizeAccountId(params.accountId);
  return path.join(stateDir, "plugins", "matrix-rust", accountId, "flushed-event-dedupe.json");
}

export function getOrCreateMatrixFlushedEventDedupe(params: {
  runtime: PluginRuntime;
  accountId: string;
  onDiskError?: (error: unknown) => void;
}): PersistentDedupe {
  const key = buildDedupeMapKey(params);
  const existing = activeDedupes.get(key);
  if (existing) {
    return existing;
  }

  const dedupe = createPersistentDedupe({
    ttlMs: DEFAULT_TTL_MS,
    memoryMaxSize: DEFAULT_MEMORY_MAX_SIZE,
    fileMaxEntries: DEFAULT_FILE_MAX_ENTRIES,
    resolveFilePath: () =>
      resolveMatrixFlushedEventDedupeFilePath({
        runtime: params.runtime,
        accountId: params.accountId,
      }),
    onDiskError: params.onDiskError,
  });
  activeDedupes.set(key, dedupe);
  return dedupe;
}

export async function markMatrixEventsFlushed(params: {
  runtime: PluginRuntime;
  accountId: string;
  events: MatrixFlushedEventRef[];
  onDiskError?: (error: unknown) => void;
}): Promise<void> {
  const dedupe = getOrCreateMatrixFlushedEventDedupe(params);
  for (const event of params.events) {
    const key = buildMatrixFlushedEventKey(event);
    if (!key) {
      continue;
    }
    await dedupe.checkAndRecord(key, {
      namespace: FLUSHED_EVENT_NAMESPACE,
      onDiskError: params.onDiskError,
    });
  }
}

export async function hasMatrixFlushedEvent(params: {
  runtime: PluginRuntime;
  accountId: string;
  event: MatrixFlushedEventRef;
}): Promise<boolean> {
  const key = buildMatrixFlushedEventKey(params.event);
  if (!key) {
    return false;
  }

  const filePath = resolveMatrixFlushedEventDedupeFilePath({
    runtime: params.runtime,
    accountId: params.accountId,
  });

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed[key] === "number" && Number.isFinite(parsed[key]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return false;
    }
    return false;
  }
}

export function clearMatrixFlushedEventDedupes(): void {
  activeDedupes.clear();
}
