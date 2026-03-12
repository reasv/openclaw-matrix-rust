import type { MatrixNativeDiagnostics, MatrixNativeEvent, MatrixSendResult } from "../../types.js";

export function decodeNativeEvents(payload: string): MatrixNativeEvent[] {
  return JSON.parse(payload) as MatrixNativeEvent[];
}

export function decodeNativeDiagnostics(payload: string): MatrixNativeDiagnostics {
  return JSON.parse(payload) as MatrixNativeDiagnostics;
}

export function decodeSendResult(payload: string): MatrixSendResult {
  return JSON.parse(payload) as MatrixSendResult;
}
