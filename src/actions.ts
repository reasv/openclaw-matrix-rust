import {
  readNumberParam,
  readStringParam,
  type ChannelMessageActionName,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionContext,
} from "openclaw/plugin-sdk/matrix";
import { resolveMatrixRustAccount } from "./matrix/accounts.js";
import type { CoreConfig, MatrixReactionSummary, ResolvedMatrixAccount } from "./types.js";

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
    if (account.config.actions?.messages !== false) {
      output.push("read", "edit", "delete");
    }
    if (account.config.actions?.pins !== false) {
      output.push("pin", "unpin", "list-pins");
    }
    if (account.config.actions?.memberInfo !== false) {
      output.push("member-info");
    }
    if (account.config.actions?.channelInfo !== false) {
      output.push("channel-info");
    }
    return output;
  },
  supportsAction: ({ action }) => action !== "poll",
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
    const account = resolveMatrixRustAccount({
      cfg: ctx.cfg as CoreConfig,
      accountId: ctx.accountId,
    });
    const client = await ensureStartedClient(account);
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

async function ensureStartedClient(account: ResolvedMatrixAccount) {
  const { ensureMatrixClientStarted } = await import("./channel.js");
  return ensureMatrixClientStarted(account);
}

export function summarizeReactionsForTool(
  reactions: MatrixReactionSummary[],
): Array<{
  display: string;
  shortcode?: string;
  kind: MatrixReactionSummary["kind"];
  count: number;
  users: string[];
}> {
  return reactions.map((reaction) => ({
    display: reaction.display,
    shortcode: reaction.shortcode,
    kind: reaction.kind,
    count: reaction.count,
    users: reaction.users,
  }));
}

function resolveRoomId(params: Record<string, unknown>, required = true): string {
  const direct = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
  if (direct) {
    return direct;
  }
  if (!required) {
    return readStringParam(params, "to") ?? "";
  }
  return readStringParam(params, "to", { required: true });
}

async function handleNonSendAction(
  ctx: ChannelMessageActionContext,
): Promise<Record<string, unknown>> {
  const account = resolveMatrixRustAccount({
    cfg: ctx.cfg as CoreConfig,
    accountId: ctx.accountId,
  });
  const reactionsEnabled = account.config.actions?.reactions !== false;
  const messagesEnabled = account.config.actions?.messages !== false;
  const pinsEnabled = account.config.actions?.pins !== false;
  const memberInfoEnabled = account.config.actions?.memberInfo !== false;
  const channelInfoEnabled = account.config.actions?.channelInfo !== false;

  if (ctx.action === "emoji-list") {
    const client = await ensureStartedClient(account);
    const roomId = resolveRoomId(ctx.params, false);
    const limit = readNumberParam(ctx.params, "limit", { integer: true }) ?? undefined;
    return {
      ok: true,
      emoji: client.listKnownShortcodes({
        roomId: roomId || undefined,
        limit,
      }),
    };
  }

  if (ctx.action === "react") {
    if (!reactionsEnabled) {
      throw new Error("Matrix reactions are disabled.");
    }
    const client = await ensureStartedClient(account);
    const roomId = resolveRoomId(ctx.params);
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
    if (!reactionsEnabled) {
      throw new Error("Matrix reactions are disabled.");
    }
    const client = await ensureStartedClient(account);
    const roomId = resolveRoomId(ctx.params);
    const messageId = readStringParam(ctx.params, "messageId", { required: true });
    const limit = readNumberParam(ctx.params, "limit", { integer: true }) ?? undefined;
    return {
      ok: true,
      reactions: summarizeReactionsForTool(
        client.listReactions({
          roomId,
          messageId,
          limit,
        }),
      ),
    };
  }

  if (ctx.action === "read") {
    if (!messagesEnabled) {
      throw new Error("Matrix messages are disabled.");
    }
    const client = await ensureStartedClient(account);
    return {
      ok: true,
      ...client.readMessages({
        roomId: resolveRoomId(ctx.params),
        limit: readNumberParam(ctx.params, "limit", { integer: true }) ?? undefined,
        before: readStringParam(ctx.params, "before") ?? undefined,
        after: readStringParam(ctx.params, "after") ?? undefined,
      }),
    };
  }

  if (ctx.action === "edit") {
    if (!messagesEnabled) {
      throw new Error("Matrix messages are disabled.");
    }
    const client = await ensureStartedClient(account);
    return {
      ok: true,
      result: client.editMessage({
        roomId: resolveRoomId(ctx.params),
        messageId: readStringParam(ctx.params, "messageId", { required: true }),
        text: readStringParam(ctx.params, "message", {
          required: true,
          allowEmpty: true,
        }),
      }),
    };
  }

  if (ctx.action === "delete") {
    if (!messagesEnabled) {
      throw new Error("Matrix messages are disabled.");
    }
    const client = await ensureStartedClient(account);
    const result = client.deleteMessage({
      roomId: resolveRoomId(ctx.params),
      messageId: readStringParam(ctx.params, "messageId", { required: true }),
      reason: readStringParam(ctx.params, "reason") ?? undefined,
    });
    return {
      ok: true,
      deleted: true,
      result,
    };
  }

  if (ctx.action === "pin") {
    if (!pinsEnabled) {
      throw new Error("Matrix pins are disabled.");
    }
    const client = await ensureStartedClient(account);
    const result = client.pinMessage({
      roomId: resolveRoomId(ctx.params),
      messageId: readStringParam(ctx.params, "messageId", { required: true }),
    });
    return {
      ok: true,
      pinned: result.pinned,
    };
  }

  if (ctx.action === "unpin") {
    if (!pinsEnabled) {
      throw new Error("Matrix pins are disabled.");
    }
    const client = await ensureStartedClient(account);
    const result = client.unpinMessage({
      roomId: resolveRoomId(ctx.params),
      messageId: readStringParam(ctx.params, "messageId", { required: true }),
    });
    return {
      ok: true,
      pinned: result.pinned,
    };
  }

  if (ctx.action === "list-pins") {
    if (!pinsEnabled) {
      throw new Error("Matrix pins are disabled.");
    }
    const client = await ensureStartedClient(account);
    const result = client.listPins({
      roomId: resolveRoomId(ctx.params),
    });
    return {
      ok: true,
      pinned: result.pinned,
      events: result.events,
    };
  }

  if (ctx.action === "member-info") {
    if (!memberInfoEnabled) {
      throw new Error("Matrix member info is disabled.");
    }
    const client = await ensureStartedClient(account);
    const userId = readStringParam(ctx.params, "userId", { required: true });
    const roomId = resolveRoomId(ctx.params);
    const resolved = client.resolveTarget({ target: roomId, createDm: false });
    const member = client.memberInfo({
      roomId: resolved.resolvedRoomId,
      userId,
    });
    return {
      ok: true,
      member,
    };
  }

  if (ctx.action === "channel-info") {
    if (!channelInfoEnabled) {
      throw new Error("Matrix room info is disabled.");
    }
    const client = await ensureStartedClient(account);
    const roomId = resolveRoomId(ctx.params);
    const roomOverride = account.config.rooms?.[roomId] ?? account.config.groups?.[roomId];
    const resolved = client.resolveTarget({ target: roomId, createDm: false });
    const channel = client.channelInfo({
      roomId: resolved.resolvedRoomId,
    });
    return {
      ok: true,
      channel: {
        ...channel,
        accountId: account.accountId,
        target: resolved.canonicalTarget,
        homeserver: account.homeserver ?? null,
        threadReplies: roomOverride?.threadReplies ?? account.config.threadReplies ?? "inbound",
        requireMention: roomOverride?.requireMention ?? true,
      },
    };
  }

  throw new Error(`Action ${ctx.action} is not supported by the Matrix Rust connector`);
}
