import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";

let runtime: PluginRuntime | null = null;

export function setMatrixRustRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getMatrixRustRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Matrix Rust runtime has not been initialized");
  }
  return runtime;
}
