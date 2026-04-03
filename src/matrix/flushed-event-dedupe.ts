import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeAccountId,
  type PluginRuntime,
} from "openclaw/plugin-sdk/matrix";

const FLUSHED_EVENT_NAMESPACE = "flushed-events";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_SIZE = 20_000;
const DEFAULT_FILE_MAX_ENTRIES = 50_000;

type PersistentDedupeCheckOptions = {
  namespace?: string;
  now?: number;
  onDiskError?: (error: unknown) => void;
};

type PersistentDedupe = {
  checkAndRecord: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
};

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

function createPersistentDedupe(options: {
  ttlMs: number;
  memoryMaxSize: number;
  fileMaxEntries: number;
  resolveFilePath: (namespace: string) => string;
  onDiskError?: (error: unknown) => void;
}): PersistentDedupe {
  const ttlMs = Math.max(0, Math.floor(options.ttlMs));
  const fileMaxEntries = Math.max(1, Math.floor(options.fileMaxEntries));
  const memoryMaxSize = Math.max(1, Math.floor(options.memoryMaxSize));
  const memory = new Map<string, number>();
  let loaded = false;
  let writeTail = Promise.resolve();

  function prune(now: number): void {
    if (ttlMs > 0) {
      for (const [key, ts] of memory.entries()) {
        if (now - ts >= ttlMs) {
          memory.delete(key);
        }
      }
    }

    if (memory.size <= fileMaxEntries && memory.size <= memoryMaxSize) {
      return;
    }

    const maxEntries = Math.min(fileMaxEntries, memoryMaxSize);
    const ordered = [...memory.entries()].sort(
      (a: [string, number], b: [string, number]) => a[1] - b[1],
    );
    const excess = ordered.length - maxEntries;
    if (excess <= 0) {
      return;
    }
    for (const [key] of ordered.slice(0, excess)) {
      memory.delete(key);
    }
  }

  async function ensureLoaded(onDiskError?: (error: unknown) => void): Promise<void> {
    if (loaded) {
      return;
    }
    loaded = true;
    const filePath = options.resolveFilePath(FLUSHED_EVENT_NAMESPACE);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const now = Date.now();
      for (const [key, ts] of Object.entries(parsed)) {
        if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
          continue;
        }
        if (ttlMs > 0 && now - ts >= ttlMs) {
          continue;
        }
        memory.set(key, ts);
      }
      prune(now);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") {
        (onDiskError ?? options.onDiskError)?.(error);
      }
    }
  }

  async function flush(onDiskError?: (error: unknown) => void): Promise<void> {
    const filePath = options.resolveFilePath(FLUSHED_EVENT_NAMESPACE);
    const dirPath = path.dirname(filePath);
    const tempPath = `${filePath}.tmp`;
    const payload = Object.fromEntries(memory.entries());
    try {
      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
      await fs.rename(tempPath, filePath);
    } catch (error) {
      (onDiskError ?? options.onDiskError)?.(error);
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore best-effort cleanup failures.
      }
    }
  }

  return {
    async checkAndRecord(key, dedupeOptions) {
      const trimmed = key.trim();
      if (!trimmed) {
        return true;
      }
      await ensureLoaded(dedupeOptions?.onDiskError);
      const now = dedupeOptions?.now ?? Date.now();
      prune(now);
      const seenAt = memory.get(trimmed);
      if (seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs)) {
        return false;
      }
      memory.set(trimmed, now);
      prune(now);
      writeTail = writeTail
        .catch(() => undefined)
        .then(async () => await flush(dedupeOptions?.onDiskError));
      await writeTail;
      return true;
    },
  };
}
