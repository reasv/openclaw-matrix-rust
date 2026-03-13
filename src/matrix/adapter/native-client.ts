import { MatrixCoreClient } from "../../../npm/index.js";
import type {
  MatrixChannelInfo,
  MatrixChannelInfoRequest,
  MatrixDownloadMediaRequest,
  MatrixDownloadMediaResult,
  MatrixNativeConfig,
  MatrixNativeDiagnostics,
  MatrixEmojiUsageRequest,
  MatrixJoinRequest,
  MatrixJoinResult,
  MatrixListEmojiRequest,
  MatrixListReactionsRequest,
  MatrixMemberInfo,
  MatrixMemberInfoRequest,
  MatrixNativeEvent,
  MatrixReactRequest,
  MatrixReactResult,
  MatrixReactionSummary,
  MatrixResolveTargetRequest,
  MatrixResolveTargetResult,
  MatrixSendRequest,
  MatrixSendResult,
  MatrixUploadMediaRequest,
  MatrixUploadMediaResult,
} from "../../types.js";
import { decodeNativeDiagnostics, decodeNativeEvents, decodeSendResult } from "./events.js";

type NativeBindingClient = {
  start(configJson: string): string;
  stop(): void;
  pollEvents(): string;
  diagnostics(): string;
  sendMessage(requestJson: string): string;
  resolveTarget(requestJson: string): string;
  joinRoom(requestJson: string): string;
  memberInfo(requestJson: string): string;
  channelInfo(requestJson: string): string;
  uploadMedia(requestJson: string): string;
  downloadMedia(requestJson: string): string;
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

  resolveTarget(request: MatrixResolveTargetRequest): MatrixResolveTargetResult {
    return JSON.parse(this.#client.resolveTarget(JSON.stringify(request))) as MatrixResolveTargetResult;
  }

  joinRoom(request: MatrixJoinRequest): MatrixJoinResult {
    return JSON.parse(this.#client.joinRoom(JSON.stringify(request))) as MatrixJoinResult;
  }

  memberInfo(request: MatrixMemberInfoRequest): MatrixMemberInfo {
    return JSON.parse(this.#client.memberInfo(JSON.stringify(request))) as MatrixMemberInfo;
  }

  channelInfo(request: MatrixChannelInfoRequest): MatrixChannelInfo {
    return JSON.parse(this.#client.channelInfo(JSON.stringify(request))) as MatrixChannelInfo;
  }

  uploadMedia(request: MatrixUploadMediaRequest): MatrixUploadMediaResult {
    return JSON.parse(this.#client.uploadMedia(JSON.stringify(request))) as MatrixUploadMediaResult;
  }

  downloadMedia(request: MatrixDownloadMediaRequest): MatrixDownloadMediaResult {
    return JSON.parse(this.#client.downloadMedia(JSON.stringify(request))) as MatrixDownloadMediaResult;
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
