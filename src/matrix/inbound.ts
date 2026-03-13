import type { MatrixNativeClient } from "./adapter/native-client.js";
import { getMatrixRustRuntime } from "../runtime.js";
import type {
  CoreConfig,
  MatrixInboundEvent,
  ResolvedMatrixAccount,
} from "../types.js";

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
  const defaultThreadId = inboundEvent.threadRootId ?? undefined;
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

  const media = await saveInboundMedia({ account, client, event });
  const bodyText = event.body.trim();
  const conversationLabel = isDirectMessage
    ? (event.senderName ?? event.senderId)
    : (event.roomName ?? event.roomAlias ?? event.roomId);
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: bodyText,
    BodyForAgent: bodyText,
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
