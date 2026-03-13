export type MatrixBufferedHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
};

export type MatrixRoomHistoryBuffer = {
  add: (scopeKey: string, entry: MatrixBufferedHistoryEntry) => void;
  snapshot: (scopeKey: string) => MatrixBufferedHistoryEntry[];
  clear: (scopeKey: string) => void;
};

export function buildMatrixHistoryScopeKey(params: {
  accountId: string;
  roomId: string;
  threadRootId?: string;
}): string {
  const accountId = params.accountId.trim();
  const roomId = params.roomId.trim();
  const threadRootId = params.threadRootId?.trim() || "";
  if (!accountId || !roomId) {
    return "";
  }
  return threadRootId
    ? `${accountId}:${roomId}:thread:${threadRootId}`
    : `${accountId}:${roomId}`;
}

export function createMatrixRoomHistoryBuffer(maxEntries = 30): MatrixRoomHistoryBuffer {
  const entriesByScope = new Map<string, MatrixBufferedHistoryEntry[]>();

  const clampEntries = (entries: MatrixBufferedHistoryEntry[]) => {
    if (maxEntries <= 0) {
      return [];
    }
    return entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
  };

  return {
    add(scopeKey, entry) {
      const key = scopeKey.trim();
      if (!key || !entry.body.trim()) {
        return;
      }
      const existing = entriesByScope.get(key) ?? [];
      entriesByScope.set(key, clampEntries([...existing, entry]));
    },
    snapshot(scopeKey) {
      const key = scopeKey.trim();
      if (!key) {
        return [];
      }
      return [...(entriesByScope.get(key) ?? [])];
    },
    clear(scopeKey) {
      const key = scopeKey.trim();
      if (!key) {
        return;
      }
      entriesByScope.delete(key);
    },
  };
}
