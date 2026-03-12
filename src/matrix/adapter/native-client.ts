import { MatrixCoreClient } from "../../../npm/index.js";
import type {
  MatrixNativeConfig,
  MatrixNativeDiagnostics,
  MatrixNativeEvent,
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
};

export class MatrixNativeClient {
  readonly #client: NativeBindingClient;

  constructor() {
    this.#client = new MatrixCoreClient();
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
}
