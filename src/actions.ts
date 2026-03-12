import {
  readStringParam,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionContext,
} from "openclaw/plugin-sdk/matrix";
import { resolveMatrixRustAccount } from "./matrix/accounts.js";
import { getOrCreateMatrixClient } from "./channel.js";
import { getMatrixRustRuntime } from "./runtime.js";
import { resolveNativeConfig } from "./matrix/adapter/config.js";
import type { CoreConfig } from "./types.js";

export const matrixRustActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const account = resolveMatrixRustAccount({ cfg: cfg as CoreConfig });
    if (!account.enabled || !account.configured) {
      return [];
    }
    return ["send"];
  },
  supportsAction: ({ action }) => action === "send",
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") {
      return null;
    }
    const to = typeof args.to === "string" ? args.to.trim() : "";
    return to ? { to } : null;
  },
  handleAction: async (ctx: ChannelMessageActionContext) => {
    if (ctx.action !== "send") {
      throw new Error(`Action ${ctx.action} is not supported by the Matrix Rust scaffold`);
    }
    const to = readStringParam(ctx.params, "to", { required: true });
    const text = readStringParam(ctx.params, "message", {
      required: true,
      allowEmpty: true,
    });
    const replyToId = readStringParam(ctx.params, "replyTo");
    const threadId = readStringParam(ctx.params, "threadId");
    const account = resolveMatrixRustAccount({ cfg: ctx.cfg as CoreConfig, accountId: ctx.accountId });
    const client = getOrCreateMatrixClient(account.accountId);
    if (!clientStarted(client)) {
      client.start(resolveNativeConfig({ account, runtime: getMatrixRustRuntime() }));
    }
    const result = client.sendMessage({
      roomId: to,
      text,
      replyToId: replyToId ?? undefined,
      threadId: threadId ?? undefined,
    });
    return {
      ok: true,
      channel: "matrix",
      roomId: result.roomId,
      messageId: result.messageId,
    };
  },
};

function clientStarted(client: { diagnostics(): { syncState: string } }): boolean {
  try {
    return client.diagnostics().syncState !== "stopped";
  } catch {
    return false;
  }
}
