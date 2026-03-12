import {
  readStringParam,
  type ChannelMessageActionName,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionContext,
} from "openclaw/plugin-sdk/matrix";
import { resolveMatrixRustAccount } from "./matrix/accounts.js";
import { ensureMatrixClientStarted } from "./channel.js";
import type { CoreConfig } from "./types.js";

export const matrixRustActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const account = resolveMatrixRustAccount({ cfg: cfg as CoreConfig });
    if (!account.enabled || !account.configured) {
      return [];
    }
    const output: ChannelMessageActionName[] = ["send", "emoji-list"];
    if (account.config.actions?.reactions !== false) {
      output.push("react", "reactions");
    }
    if (account.config.actions?.memberInfo !== false) {
      output.push("member-info");
    }
    if (account.config.actions?.channelInfo !== false) {
      output.push("channel-info");
    }
    return output;
  },
  supportsAction: ({ action }) =>
    action === "send" ||
    action === "react" ||
    action === "reactions" ||
    action === "emoji-list" ||
    action === "member-info" ||
    action === "channel-info",
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
      return await handleNonSendAction(ctx);
    }
    const to = readStringParam(ctx.params, "to", { required: true });
    const text = readStringParam(ctx.params, "message", {
      required: true,
      allowEmpty: true,
    });
    const replyToId = readStringParam(ctx.params, "replyTo");
    const threadId = readStringParam(ctx.params, "threadId");
    const account = resolveMatrixRustAccount({ cfg: ctx.cfg as CoreConfig, accountId: ctx.accountId });
    const client = ensureMatrixClientStarted(account);
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

async function handleNonSendAction(
  ctx: ChannelMessageActionContext,
): Promise<Record<string, unknown>> {
  const account = resolveMatrixRustAccount({
    cfg: ctx.cfg as CoreConfig,
    accountId: ctx.accountId,
  });
  const client = ensureMatrixClientStarted(account);

  if (ctx.action === "emoji-list") {
    const roomId =
      readStringParam(ctx.params, "roomId") ??
      readStringParam(ctx.params, "channelId") ??
      readStringParam(ctx.params, "to");
    const limitRaw = ctx.params.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(0, Math.floor(limitRaw)) : undefined;
    return {
      ok: true,
      emoji: client.listKnownShortcodes({
        roomId: roomId ?? undefined,
        limit,
      }),
    };
  }

  if (ctx.action === "react") {
    const roomId =
      readStringParam(ctx.params, "roomId") ??
      readStringParam(ctx.params, "channelId") ??
      readStringParam(ctx.params, "to", { required: true });
    const messageId = readStringParam(ctx.params, "messageId", { required: true });
    const remove = Boolean(ctx.params.remove);
    const emoji = readStringParam(ctx.params, "emoji", {
      required: true,
      allowEmpty: false,
    });
    const result = client.reactMessage({
      roomId,
      messageId,
      key: emoji,
      remove,
    });
    return {
      ok: true,
      removed: result.removed,
      reaction: result.reaction ?? null,
    };
  }

  if (ctx.action === "reactions") {
    const roomId =
      readStringParam(ctx.params, "roomId") ??
      readStringParam(ctx.params, "channelId") ??
      readStringParam(ctx.params, "to", { required: true });
    const messageId = readStringParam(ctx.params, "messageId", { required: true });
    const limitRaw = ctx.params.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(0, Math.floor(limitRaw)) : undefined;
    return {
      ok: true,
      reactions: client.listReactions({
        roomId,
        messageId,
        limit,
      }),
    };
  }

  if (ctx.action === "member-info") {
    const userId = readStringParam(ctx.params, "userId", { required: true });
    const diagnostics = client.diagnostics();
    return {
      ok: true,
      member: {
        userId,
        known: userId === diagnostics.userId,
        isSelf: userId === diagnostics.userId,
        accountId: account.accountId,
        homeserver: account.homeserver ?? null,
        note:
          userId === diagnostics.userId
            ? "Resolved from active Matrix device diagnostics."
            : "Native member directory lookup is not implemented yet.",
      },
    };
  }

  if (ctx.action === "channel-info") {
    const roomId =
      readStringParam(ctx.params, "roomId") ??
      readStringParam(ctx.params, "channelId") ??
      readStringParam(ctx.params, "to", { required: true });
    const diagnostics = client.diagnostics();
    const roomOverride =
      account.config.rooms?.[roomId] ??
      account.config.groups?.[roomId];
    return {
      ok: true,
      channel: {
        roomId,
        accountId: account.accountId,
        homeserver: account.homeserver ?? null,
        userId: diagnostics.userId || account.userId || null,
        deviceId: diagnostics.deviceId || null,
        syncState: diagnostics.syncState,
        verificationState: diagnostics.verificationState,
        threadReplies: roomOverride?.threadReplies ?? account.config.threadReplies ?? "inbound",
        requireMention: roomOverride?.requireMention ?? true,
      },
    };
  }

  throw new Error(`Action ${ctx.action} is not supported by the Matrix Rust scaffold`);
}
