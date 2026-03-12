import { MatrixCoreClient } from "../../../npm/index.js";
import type {
  MatrixNativeConfig,
  MatrixNativeDiagnostics,
  MatrixEmojiUsageRequest,
  MatrixListEmojiRequest,
  MatrixListReactionsRequest,
  MatrixNativeEvent,
  MatrixReactRequest,
  MatrixReactResult,
  MatrixReactionSummary,
  MatrixSendRequest,
  MatrixSendResult,
} from "../../types.js";
import { decodeNativeDiagnostics, decodeNativeEvents, decodeSendResult } from "./events.js";

type NativeBindingClient = {
  start(configJson: string): string;
  stop(): void;
  pollEvents(): string;
  diagnostics(): string;
  sendMessage(requestJson: string): string;
  reactMessage(requestJson: string): string;
  listReactions(requestJson: string): string;
  recordCustomEmojiUsage(requestJson: string): void;
  listKnownShortcodes(requestJson: string): string;
};

export class MatrixNativeClient {
  readonly #client: NativeBindingClient;

  constructor() {
    this.#client = new MatrixCoreClient() as unknown as NativeBindingClient;
  }

  start(config: MatrixNativeConfig): MatrixNativeDiagnostics {
    return decodeNativeDiagnostics(this.#client.start(JSON.stringify(config)));
  }

  stop(): void {
    this.#client.stop();
  }

  diagnostics(): MatrixNativeDiagnostics {
    return decodeNativeDiagnostics(this.#client.diagnostics());
  }

  pollEvents(): MatrixNativeEvent[] {
    return decodeNativeEvents(this.#client.pollEvents());
  }

  sendMessage(request: MatrixSendRequest): MatrixSendResult {
    return decodeSendResult(this.#client.sendMessage(JSON.stringify(request)));
  }

  reactMessage(request: MatrixReactRequest): MatrixReactResult {
    return JSON.parse(this.#client.reactMessage(JSON.stringify(request))) as MatrixReactResult;
  }

  listReactions(request: MatrixListReactionsRequest): MatrixReactionSummary[] {
    return JSON.parse(this.#client.listReactions(JSON.stringify(request))) as MatrixReactionSummary[];
  }

  recordCustomEmojiUsage(request: MatrixEmojiUsageRequest): void {
    this.#client.recordCustomEmojiUsage(JSON.stringify(request));
  }

  listKnownShortcodes(request: MatrixListEmojiRequest = {}): string[] {
    return JSON.parse(this.#client.listKnownShortcodes(JSON.stringify(request))) as string[];
  }
}
