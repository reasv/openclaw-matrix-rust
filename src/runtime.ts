import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";

let runtime: PluginRuntime | null = null;
const pendingUserProfileHints = new Map<string, string>();

export function setMatrixRustRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getMatrixRustRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Matrix Rust runtime has not been initialized");
  }
  return runtime;
}

export function setPendingMatrixUserProfileHint(sessionKey: string, hint: string | undefined): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  if (hint) {
    pendingUserProfileHints.set(key, hint);
    return;
  }
  pendingUserProfileHints.delete(key);
}

export function takePendingMatrixUserProfileHint(sessionKey: string | undefined): string | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  const hint = pendingUserProfileHints.get(key);
  pendingUserProfileHints.delete(key);
  return hint;
}

export function clearPendingMatrixUserProfileHints(): void {
  pendingUserProfileHints.clear();
}
