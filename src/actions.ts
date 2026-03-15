import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  readNumberParam,
  readStringParam,
  type ChannelMessageActionName,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionContext,
} from "openclaw/plugin-sdk/matrix";
import { resolveMatrixRustAccount } from "./matrix/accounts.js";
import { sendMatrixMedia } from "./matrix/inbound.js";
import { getMatrixRustRuntime } from "./runtime.js";
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
    const mediaUrl = resolveSendMediaUrl(ctx.params);
    const replyToId = readStringParam(ctx.params, "replyTo");
    const threadId = readStringParam(ctx.params, "threadId");
    const account = resolveMatrixRustAccount({
      cfg: ctx.cfg as CoreConfig,
      accountId: ctx.accountId,
    });
    const client = await ensureStartedClient(account);
    if (mediaUrl) {
      const result = await sendMatrixMedia({
        account,
        client,
        to,
        mediaUrl,
        text: resolveOptionalSendMessage(ctx.params),
        mediaLocalRoots: ctx.mediaLocalRoots,
        replyToId: replyToId ?? undefined,
        threadId: threadId ?? undefined,
      });
      return {
        ok: true,
        channel: "matrix",
        roomId: result.to,
        messageId: result.messageId,
      };
    }
    const text = readStringParam(ctx.params, "message", {
      required: true,
      allowEmpty: true,
    });
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

function isTruthyParam(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function resolveMediaMaxBytes(account: ResolvedMatrixAccount): number {
  const limitMb = Math.max(1, account.config.mediaMaxMb ?? 20);
  return limitMb * 1024 * 1024;
}

function isImageDownload(downloaded: {
  kind?: string;
  contentType?: string;
}): boolean {
  const kind = downloaded.kind?.trim().toLowerCase();
  if (kind === "image") {
    return true;
  }
  return downloaded.contentType?.trim().toLowerCase().startsWith("image/") ?? false;
}

function sanitizeMatrixDownloadFilename(filename?: string, fallbackBase = "attachment"): string {
  const trimmed = filename?.trim();
  const candidate = trimmed ? path.basename(trimmed) : fallbackBase;
  const sanitized = candidate
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return sanitized || fallbackBase;
}

function resolveAgentVisibleDownloadRoot(params: {
  mediaLocalRoots?: readonly string[];
  runtime: ReturnType<typeof getMatrixRustRuntime>;
}): string | undefined {
  const roots = (params.mediaLocalRoots ?? [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  if (roots.length === 0) {
    return undefined;
  }
  const stateDir = params.runtime.state.resolveStateDir();
  const normalizedStateDir = typeof stateDir === "string" ? path.resolve(stateDir) : "";
  const prefer = (candidate: string): number => {
    const resolved = path.resolve(candidate);
    const underState =
      normalizedStateDir.length > 0 &&
      (resolved === normalizedStateDir || resolved.startsWith(`${normalizedStateDir}${path.sep}`));
    if (!underState) {
      return 0;
    }
    if (resolved.includes(`${path.sep}sandboxes${path.sep}`) || resolved.endsWith(`${path.sep}sandboxes`)) {
      return 4;
    }
    if (resolved.includes(`${path.sep}media${path.sep}`) || resolved.endsWith(`${path.sep}media`)) {
      return 3;
    }
    if (
      resolved.includes(`${path.sep}workspace${path.sep}`) ||
      resolved.endsWith(`${path.sep}workspace`)
    ) {
      return 1;
    }
    return 2;
  };
  const sorted = roots
    .map((root, index) => ({ root, index, score: prefer(root) }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return right.index - left.index;
    });
  return sorted[0]?.root;
}

async function persistDownloadedMatrixMedia(params: {
  account: ResolvedMatrixAccount;
  downloaded: {
    dataBase64: string;
    contentType?: string;
    filename?: string;
  };
}): Promise<{ path: string; contentType?: string }> {
  const runtime = getMatrixRustRuntime() as any;
  const persisted = await runtime.channel.media.saveMediaBuffer(
    Buffer.from(params.downloaded.dataBase64, "base64"),
    params.downloaded.contentType,
    "inbound",
    resolveMediaMaxBytes(params.account),
    params.downloaded.filename,
  );
  return {
    path: persisted.path,
    contentType: persisted.contentType ?? params.downloaded.contentType,
  };
}

async function stageDownloadedMatrixMediaForAgent(params: {
  downloaded: {
    dataBase64: string;
    contentType?: string;
    filename?: string;
  };
  mediaLocalRoots?: readonly string[];
}): Promise<{ path: string; contentType?: string } | null> {
  const runtime = getMatrixRustRuntime();
  const root = resolveAgentVisibleDownloadRoot({
    mediaLocalRoots: params.mediaLocalRoots,
    runtime,
  });
  if (!root) {
    return null;
  }
  const baseName = sanitizeMatrixDownloadFilename(params.downloaded.filename);
  const parsed = path.parse(baseName);
  const uniqueName = `${parsed.name || "attachment"}---${crypto.randomUUID()}${parsed.ext}`;
  const dir = path.join(root, "downloads", "matrix-read");
  const outputPath = path.join(dir, uniqueName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(params.downloaded.dataBase64, "base64"));
  return {
    path: outputPath,
    contentType: params.downloaded.contentType,
  };
}

function buildReadImageContent(params: {
  eventId: string;
  downloaded: {
    filename?: string;
    contentType?: string;
    dataBase64: string;
  };
}): Array<Record<string, unknown>> {
  const filename = params.downloaded.filename?.trim() || "attachment";
  const contentType = params.downloaded.contentType?.trim() || "image/jpeg";
  return [
    {
      type: "text",
      text: `Retrieved image attachment for ${params.eventId}: filename="${filename}" type="${contentType}"`,
    },
    {
      type: "image",
      data: params.downloaded.dataBase64,
      mimeType: contentType,
      fileName: filename,
    },
  ];
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

function resolveOptionalSendMessage(params: Record<string, unknown>): string | undefined {
  const raw = params.message;
  return typeof raw === "string" ? raw : undefined;
}

function resolveSendMediaUrl(params: Record<string, unknown>): string | undefined {
  const candidates = [params.media, params.mediaUrl, params.path, params.filePath];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
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
    const roomId = resolveRoomId(ctx.params);
    const eventId = readStringParam(ctx.params, "eventId") ?? readStringParam(ctx.params, "messageId");
    const includeImage = isTruthyParam(ctx.params.includeImage);
    const downloadImage = isTruthyParam(ctx.params.downloadImage);
    const includeMedia = isTruthyParam(ctx.params.includeMedia);
    const downloadMedia = isTruthyParam(ctx.params.downloadMedia);
    if (eventId) {
      const message = client.messageSummary({
        roomId,
        eventId,
      });
      if (!message) {
        return {
          ok: true,
          roomId,
          eventId,
          message: null,
          media: [],
        };
      }
      let media: Array<Record<string, unknown>> = [];
      let content: Array<Record<string, unknown>> | undefined;
      let details: Record<string, unknown> | undefined;
      const shouldDownload = includeImage || downloadImage || includeMedia || downloadMedia;
      if (includeMedia) {
        // handled below
      }
      if (shouldDownload) {
        try {
          const downloaded = client.downloadMedia({
            roomId,
            eventId,
          });
          const isImage = isImageDownload(downloaded);
          if (includeImage && isImage) {
            content = buildReadImageContent({
              eventId,
              downloaded,
            });
          }
          if (downloadImage && isImage) {
            const staged = await stageDownloadedMatrixMediaForAgent({
              downloaded,
              mediaLocalRoots: ctx.mediaLocalRoots,
            });
            media.push({
              eventId,
              kind: downloaded.kind,
              filename: downloaded.filename ?? null,
              contentType: downloaded.contentType ?? null,
              stagedPath: staged?.path ?? null,
              stagedContentType: staged?.contentType ?? downloaded.contentType ?? null,
            });
            details = {
              ...(details ?? {}),
              downloadImage:
                staged != null
                  ? {
                      eventId,
                      filename: downloaded.filename ?? null,
                      contentType: downloaded.contentType ?? null,
                      path: staged.path,
                    }
                  : {
                      eventId,
                      filename: downloaded.filename ?? null,
                      contentType: downloaded.contentType ?? null,
                      error: "No agent-visible media root available for downloadImage.",
                    },
            };
          }
          if (includeMedia || downloadMedia) {
            const persisted = await persistDownloadedMatrixMedia({
              account,
              downloaded,
            });
            media.push({
              eventId,
              kind: downloaded.kind,
              filename: downloaded.filename ?? null,
              contentType: downloaded.contentType ?? null,
              savedPath: persisted.path,
              savedContentType: persisted.contentType ?? null,
            });
          }
        } catch (err) {
          media = [
            {
              eventId,
              error: String(err),
            },
          ];
          details = {
            ...(details ?? {}),
            error: String(err),
          };
        }
      }
      const result: Record<string, unknown> = {
        ok: true,
        roomId,
        eventId,
        message,
        media,
      };
      if (content && content.length > 0) {
        result.content = content;
      }
      if (details && Object.keys(details).length > 0) {
        result.details = details;
      }
      return result;
    }
    return {
      ok: true,
      ...client.readMessages({
        roomId,
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
