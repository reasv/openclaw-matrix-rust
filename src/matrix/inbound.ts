import type { MatrixNativeClient } from "./adapter/native-client.js";
import { getMatrixRustRuntime } from "../runtime.js";
import type {
  CoreConfig,
  MatrixInboundEvent,
  ResolvedMatrixAccount,
  MatrixRoomConfig,
  MatrixThreadRepliesMode,
} from "../types.js";

const MAX_INBOUND_HISTORY = 12;
const inboundHistories = new Map<
  string,
  Array<{ sender: string; body: string; timestamp?: number }>
>();

function resolveMediaMaxBytes(account: ResolvedMatrixAccount): number {
  const limitMb = Math.max(1, account.config.mediaMaxMb ?? 20);
  return limitMb * 1024 * 1024;
}

function resolveBaseRouteSession(params: {
  runtime: any;
  baseRoute: {
    agentId: string;
    sessionKey: string;
    mainSessionKey: string;
    matchedBy?: string;
  };
  isDirectMessage: boolean;
  roomId: string;
  accountId?: string | null;
}): { sessionKey: string; lastRoutePolicy: "main" | "session" } {
  const sessionKey =
    params.isDirectMessage && params.baseRoute.matchedBy === "binding.peer.parent"
      ? params.runtime.channel.routing.buildAgentSessionKey({
          agentId: params.baseRoute.agentId,
          channel: "matrix",
          accountId: params.accountId,
          peer: { kind: "channel", id: params.roomId },
        })
      : params.baseRoute.sessionKey;
  return {
    sessionKey,
    lastRoutePolicy: sessionKey === params.baseRoute.mainSessionKey ? "main" : "session",
  };
}

function resolveRoomConfig(
  account: ResolvedMatrixAccount,
  event: MatrixInboundEvent,
): MatrixRoomConfig | undefined {
  const rooms = account.config.rooms ?? account.config.groups;
  if (!rooms) {
    return undefined;
  }
  return (
    rooms[event.roomId] ??
    (event.roomAlias ? rooms[event.roomAlias] : undefined)
  );
}

function appendInboundHistory(params: {
  sessionKey: string;
  event: MatrixInboundEvent;
}): Array<{ sender: string; body: string; timestamp?: number }> {
  const entry = {
    sender: params.event.senderName ?? params.event.senderId,
    body: params.event.body.trim(),
    timestamp: Date.parse(params.event.timestamp),
  };
  const next = [...(inboundHistories.get(params.sessionKey) ?? []), entry]
    .filter((item) => item.body)
    .slice(-MAX_INBOUND_HISTORY);
  inboundHistories.set(params.sessionKey, next);
  return next.slice(0, -1);
}

function resolveThreadRepliesMode(
  account: ResolvedMatrixAccount,
  event: MatrixInboundEvent,
): MatrixThreadRepliesMode {
  return (
    resolveRoomConfig(account, event)?.threadReplies ??
    account.config.threadReplies ??
    "inbound"
  );
}

function resolveThreadTarget(
  account: ResolvedMatrixAccount,
  event: MatrixInboundEvent,
): string | undefined {
  const mode = resolveThreadRepliesMode(account, event);
  if (mode === "off") {
    return undefined;
  }
  if (mode === "inbound") {
    return event.threadRootId ?? undefined;
  }
  return event.threadRootId ?? event.eventId;
}

function shouldRequireMention(
  account: ResolvedMatrixAccount,
  event: MatrixInboundEvent,
): boolean {
  if (event.chatType === "direct") {
    return false;
  }
  const room = resolveRoomConfig(account, event);
  if (room?.autoReply === true) {
    return false;
  }
  if (room?.autoReply === false) {
    return true;
  }
  if (typeof room?.requireMention === "boolean") {
    return room.requireMention;
  }
  return true;
}

function detectExplicitMention(
  event: MatrixInboundEvent,
  diagnosticsUserId: string,
): boolean {
  if (!diagnosticsUserId) {
    return false;
  }
  return (
    event.body.includes(diagnosticsUserId) ||
    Boolean(event.formattedBody?.includes(diagnosticsUserId))
  );
}

async function recordInboundEmojiUsage(params: {
  client: MatrixNativeClient;
  event: MatrixInboundEvent;
}): Promise<void> {
  const { client, event } = params;
  const formattedBody = event.formattedBody?.trim();
  if (!formattedBody) {
    return;
  }
  const matches = Array.from(
    formattedBody.matchAll(
      /<img\b[^>]*data-mx-emoticon[^>]*src=(?:"([^"]+)"|'([^']+)')[^>]*alt=(?:"(:[^"]+:)"|'(:[^']+:)')[^>]*>/gi,
    ),
  );
  if (matches.length === 0) {
    return;
  }
  client.recordCustomEmojiUsage({
    roomId: event.roomId,
    observedAtMs: Date.parse(event.timestamp),
    emoji: matches
      .map((match) => ({
        mxcUrl: match[1] ?? match[2] ?? "",
        shortcode: match[3] ?? match[4] ?? "",
      }))
      .filter((entry) => entry.mxcUrl.startsWith("mxc://") && entry.shortcode.startsWith(":")),
  });
}

async function loadOutboundMedia(params: {
  mediaUrl: string;
  maxBytes: number;
  runtime: any;
}): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
  const { mediaUrl, maxBytes, runtime } = params;
  if (/^https?:\/\//i.test(mediaUrl)) {
    const loaded = await runtime.channel.media.fetchRemoteMedia({
      url: mediaUrl,
      maxBytes,
    });
    return {
      buffer: Buffer.from(loaded.buffer),
      contentType: loaded.contentType,
      fileName: loaded.fileName,
    };
  }

  const loaded = await runtime.media.loadWebMedia(mediaUrl, { maxBytes });
  return {
    buffer: Buffer.from(loaded.buffer),
    contentType: loaded.contentType,
    fileName: loaded.fileName,
  };
}

export async function sendMatrixMedia(params: {
  account: ResolvedMatrixAccount;
  client: MatrixNativeClient;
  to: string;
  mediaUrl: string;
  text?: string;
  replyToId?: string;
  threadId?: string;
}): Promise<{ channel: "matrix"; to: string; messageId: string }> {
  const runtime = getMatrixRustRuntime() as any;
  const maxBytes = resolveMediaMaxBytes(params.account);
  const loaded = await loadOutboundMedia({
    mediaUrl: params.mediaUrl,
    maxBytes,
    runtime,
  });
  const result = params.client.uploadMedia({
    roomId: params.to,
    filename: loaded.fileName ?? "attachment",
    contentType: loaded.contentType ?? "application/octet-stream",
    dataBase64: loaded.buffer.toString("base64"),
    caption: params.text ?? undefined,
    replyToId: params.replyToId ?? undefined,
    threadId: params.threadId ?? undefined,
  });
  return {
    channel: "matrix",
    to: params.to,
    messageId: result.messageId,
  };
}

async function saveInboundMedia(params: {
  account: ResolvedMatrixAccount;
  client: MatrixNativeClient;
  event: MatrixInboundEvent;
}): Promise<Array<{ path: string; contentType?: string }>> {
  const { account, client, event } = params;
  if (event.media.length === 0) {
    return [];
  }

  const runtime = getMatrixRustRuntime() as any;
  const maxBytes = resolveMediaMaxBytes(account);
  const saved: Array<{ path: string; contentType?: string }> = [];

  for (const item of event.media) {
    const downloaded = client.downloadMedia({
      roomId: event.roomId,
      eventId: event.eventId,
    });
    const persisted = await runtime.channel.media.saveMediaBuffer(
      Buffer.from(downloaded.dataBase64, "base64"),
      downloaded.contentType ?? item.contentType,
      "inbound",
      maxBytes,
      downloaded.filename ?? item.filename,
    );
    saved.push({
      path: persisted.path,
      contentType: persisted.contentType ?? downloaded.contentType ?? item.contentType,
    });
  }

  return saved;
}

async function savePreviewMedia(params: {
  account: ResolvedMatrixAccount;
  media: Array<{ dataBase64: string; contentType?: string; filename?: string }>;
}): Promise<Array<{ path: string; contentType?: string }>> {
  const runtime = getMatrixRustRuntime() as any;
  const maxBytes = resolveMediaMaxBytes(params.account);
  const saved: Array<{ path: string; contentType?: string }> = [];
  for (const item of params.media) {
    const persisted = await runtime.channel.media.saveMediaBuffer(
      Buffer.from(item.dataBase64, "base64"),
      item.contentType,
      "inbound",
      maxBytes,
      item.filename,
    );
    saved.push({
      path: persisted.path,
      contentType: persisted.contentType ?? item.contentType,
    });
  }
  return saved;
}

async function deliverReplyPayload(params: {
  cfg: CoreConfig;
  account: ResolvedMatrixAccount;
  client: MatrixNativeClient;
  inboundEvent: MatrixInboundEvent;
  payload: {
    text?: string;
    body?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
  };
}): Promise<void> {
  const { account, client, inboundEvent, payload } = params;
  const text = (payload.text ?? payload.body ?? "").trim();
  const mediaUrls = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  const defaultThreadId = resolveThreadTarget(account, inboundEvent);
  const defaultReplyToId =
    account.config.replyToMode === "off" ? undefined : (payload.replyToId ?? inboundEvent.eventId);

  if (mediaUrls.length > 0) {
    let first = true;
    for (const mediaUrl of mediaUrls) {
      await sendMatrixMedia({
        account,
        client,
        to: inboundEvent.roomId,
        mediaUrl,
        text: first ? text || undefined : undefined,
        replyToId: defaultReplyToId,
        threadId: defaultThreadId,
      });
      first = false;
    }
    return;
  }

  if (!text && !defaultReplyToId) {
    return;
  }

  client.sendMessage({
    roomId: inboundEvent.roomId,
    text,
    replyToId: defaultReplyToId,
    threadId: defaultThreadId,
  });
}

export async function handleMatrixInboundEvent(params: {
  cfg: CoreConfig;
  account: ResolvedMatrixAccount;
  client: MatrixNativeClient;
  event: MatrixInboundEvent;
  log?: { info?: (message: string) => void; debug?: (message: string) => void };
}): Promise<void> {
  const { cfg, account, client, event, log } = params;
  const runtime = getMatrixRustRuntime() as any;
  const diagnostics = client.diagnostics();
  if (event.senderId === diagnostics.userId) {
    return;
  }

  if (event.chatType !== "direct" && account.config.groupPolicy === "blocked") {
    return;
  }

  const isDirectMessage = event.chatType === "direct";
  const baseRoute = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "matrix",
    accountId: account.accountId,
    peer: {
      kind: isDirectMessage ? "direct" : "channel",
      id: isDirectMessage ? event.senderId : event.roomId,
    },
    parentPeer: isDirectMessage ? { kind: "channel", id: event.roomId } : undefined,
  });
  const routeSession = resolveBaseRouteSession({
    runtime,
    baseRoute,
    isDirectMessage,
    roomId: event.roomId,
    accountId: account.accountId,
  });
  const route = {
    ...baseRoute,
    lastRoutePolicy: routeSession.lastRoutePolicy,
    sessionKey: event.threadRootId
      ? `${routeSession.sessionKey}:thread:${event.threadRootId}`
      : routeSession.sessionKey,
  };

  const mentionRegexes = runtime.channel.mentions.buildMentionRegexes(cfg, route.agentId);
  const explicitMention = detectExplicitMention(event, diagnostics.userId);
  const baseBodyText = event.body.trim();
  let previewTextBlocks: string[] = [];
  let previewMedia: Array<{ path: string; contentType?: string }> = [];
  try {
    const previewResult = client.resolveLinkPreviews({
      bodyText: baseBodyText,
      maxBytes: resolveMediaMaxBytes(account),
      includeImages: true,
      xPreviewViaFxTwitter: account.config.xPreviewViaFxTwitter === true,
    });
    previewTextBlocks = previewResult.textBlocks;
    previewMedia = await savePreviewMedia({
      account,
      media: previewResult.media,
    });
  } catch (err) {
    log?.debug?.(
      `[matrix:${account.accountId}] preview resolution failed for ${event.eventId}: ${String(err)}`,
    );
  }
  const bodyText = [baseBodyText, ...previewTextBlocks].filter(Boolean).join("\n").trim();
  const wasMentioned =
    event.chatType === "direct"
      ? true
      : runtime.channel.mentions.matchesMentionWithExplicit({
          text: baseBodyText,
          mentionRegexes,
          explicitWasMentioned: explicitMention,
        });
  const inboundHistory = appendInboundHistory({
    sessionKey: route.sessionKey,
    event: {
      ...event,
      body: bodyText,
    },
  });
  if (event.chatType !== "direct" && shouldRequireMention(account, event) && !wasMentioned) {
    return;
  }

  await recordInboundEmojiUsage({ client, event });

  const media = [
    ...(await saveInboundMedia({ account, client, event })),
    ...previewMedia,
  ];
  const conversationLabel = isDirectMessage
    ? (event.senderName ?? event.senderId)
    : (event.roomName ?? event.roomAlias ?? event.roomId);
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: bodyText,
    BodyForAgent: bodyText,
    InboundHistory: inboundHistory.length > 0 ? inboundHistory : undefined,
    RawBody: bodyText,
    CommandBody: bodyText,
    From: isDirectMessage ? `matrix:${event.senderId}` : `matrix:channel:${event.roomId}`,
    To: `room:${event.roomId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: event.chatType,
    ConversationLabel: conversationLabel,
    SenderName: event.senderName,
    SenderId: event.senderId,
    WasMentioned: event.chatType === "direct" ? undefined : wasMentioned,
    Provider: "matrix",
    Surface: "matrix",
    MessageSid: event.eventId,
    ReplyToId: event.replyToId,
    MessageThreadId: event.threadRootId,
    Timestamp: Date.parse(event.timestamp),
    MediaPath: media[0]?.path,
    MediaPaths: media.length > 0 ? media.map((item) => item.path) : undefined,
    MediaType: media[0]?.contentType,
    MediaTypes: media.length > 0 ? media.map((item) => item.contentType) : undefined,
    MediaUrl: media[0]?.path,
    MediaUrls: media.length > 0 ? media.map((item) => item.path) : undefined,
    GroupSubject: isDirectMessage ? undefined : conversationLabel,
    GroupChannel: isDirectMessage ? undefined : (event.roomAlias ?? event.roomId),
    OriginatingChannel: "matrix",
    OriginatingTo: `room:${event.roomId}`,
    LinkPreviews: previewTextBlocks.length > 0 ? previewTextBlocks : undefined,
  });

  const storePath = runtime.channel.session.resolveStorePath((cfg as any).session?.store, {
    agentId: route.agentId,
  });
  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: isDirectMessage
      ? {
          sessionKey: route.mainSessionKey,
          channel: "matrix",
          to: `room:${event.roomId}`,
          accountId: route.accountId,
        }
      : undefined,
  });

  log?.debug?.(
    `[matrix:${account.accountId}] inbound ${event.eventId} room=${event.roomId} sender=${event.senderId}`,
  );

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: {
        text?: string;
        body?: string;
        mediaUrl?: string;
        mediaUrls?: string[];
        replyToId?: string;
      }) => {
        await deliverReplyPayload({
          cfg,
          account,
          client,
          inboundEvent: event,
          payload,
        });
      },
      onError: (err: unknown, info: { kind?: string }) => {
        log?.info?.(
          `[matrix:${account.accountId}] ${info.kind ?? "reply"} failed: ${String(err)}`,
        );
      },
    },
  });
}
