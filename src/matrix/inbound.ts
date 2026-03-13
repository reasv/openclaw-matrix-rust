import type { MatrixNativeClient } from "./adapter/native-client.js";
import { getMatrixRustRuntime } from "../runtime.js";
import {
  createReplyPrefixOptions,
  createScopedPairingAccess,
  createTypingCallbacks,
  dispatchReplyFromConfigWithSettledDispatcher,
  evaluateGroupRouteAccessForPolicy,
  formatAllowlistMatchMeta,
  logInboundDrop,
  resolveControlCommandGate,
} from "openclaw/plugin-sdk/matrix";
import type {
  CoreConfig,
  MatrixInboundEvent,
  ResolvedMatrixAccount,
  MatrixRoomConfig,
  MatrixThreadRepliesMode,
} from "../types.js";
import {
  enforceMatrixDirectMessageAccess,
  resolveMatrixAccessState,
} from "./access-policy.js";
import {
  normalizeMatrixAllowList,
  resolveMatrixAllowListMatch,
  resolveMatrixAllowListMatches,
} from "./allowlist.js";
import { resolveMatrixRoomConfig } from "./rooms.js";

const DEFAULT_ROOM_HISTORY_MAX_ENTRIES = 30;
const DEFAULT_STARTUP_GRACE_MS = 5_000;
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
  return resolveMatrixRoomConfig({
    rooms: account.config.rooms ?? account.config.groups,
    roomId: event.roomId,
    aliases: event.roomAlias ? [event.roomAlias] : [],
  }).config;
}

function resolveRoomHistoryMaxEntries(account: ResolvedMatrixAccount): number {
  return Math.max(
    0,
    Math.floor(account.config.roomHistoryMaxEntries ?? DEFAULT_ROOM_HISTORY_MAX_ENTRIES),
  );
}

function bufferInboundHistory(params: {
  sessionKey: string;
  event: MatrixInboundEvent;
  maxEntries: number;
}): void {
  const entry = {
    sender: params.event.senderName ?? params.event.senderId,
    body: params.event.body.trim(),
    timestamp: Date.parse(params.event.timestamp),
  };
  const next = [...(inboundHistories.get(params.sessionKey) ?? []), entry]
    .filter((item) => item.body)
    .slice(-params.maxEntries);
  inboundHistories.set(params.sessionKey, next);
}

function consumeInboundHistory(
  sessionKey: string,
): Array<{ sender: string; body: string; timestamp?: number }> {
  const buffered = inboundHistories.get(sessionKey) ?? [];
  inboundHistories.delete(sessionKey);
  return buffered.slice(0, -1);
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
  room: MatrixRoomConfig | undefined,
  isDirectMessage: boolean,
): boolean {
  if (isDirectMessage) {
    return false;
  }
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

function shouldOverrideDmToGroup(params: {
  isDirectMessage: boolean;
  roomConfigInfo:
    | {
        config?: MatrixRoomConfig;
        allowed: boolean;
        matchSource?: string;
      }
    | undefined;
}): boolean {
  return (
    params.isDirectMessage === true &&
    params.roomConfigInfo?.config !== undefined &&
    params.roomConfigInfo.allowed === true &&
    params.roomConfigInfo.matchSource === "direct"
  );
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

export function extractMatrixCustomEmojiUsageFromFormattedBody(
  formattedBody: string,
): Array<{ mxcUrl: string; shortcode: string }> {
  const imgTagPattern = /<img\b[^>]*>/gis;
  const attrPattern =
    /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gis;
  const entries = new Map<string, { mxcUrl: string; shortcode: string }>();

  for (const match of formattedBody.matchAll(imgTagPattern)) {
    const rawTag = match[0] ?? "";
    if (!/data-mx-emoticon/i.test(rawTag)) {
      continue;
    }

    let mxcUrl = "";
    let shortcode = "";
    for (const captures of rawTag.matchAll(attrPattern)) {
      const name = (captures[1] ?? "").toLowerCase();
      const value = captures[2] ?? captures[3] ?? "";
      if ((name === "src" || name === "data-mx-src") && !mxcUrl) {
        mxcUrl = value;
      } else if (name === "alt" && !shortcode) {
        shortcode = value;
      }
    }

    if (!mxcUrl.startsWith("mxc://") || !shortcode.startsWith(":")) {
      continue;
    }
    entries.set(`${shortcode}\u0000${mxcUrl}`, { mxcUrl, shortcode });
  }

  return [...entries.values()];
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
  const emoji = extractMatrixCustomEmojiUsageFromFormattedBody(formattedBody);
  if (emoji.length === 0) {
    return;
  }
  client.recordCustomEmojiUsage({
    roomId: event.roomId,
    observedAtMs: Date.parse(event.timestamp),
    emoji,
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

  const eventTimestamp = Date.parse(event.timestamp);
  const startupTimestamp = diagnostics.startedAt ? Date.parse(diagnostics.startedAt) : NaN;
  if (
    Number.isFinite(eventTimestamp) &&
    Number.isFinite(startupTimestamp) &&
    eventTimestamp < startupTimestamp - DEFAULT_STARTUP_GRACE_MS
  ) {
    return;
  }

  const allowlistOnly = account.config.allowlistOnly === true;
  const groupPolicyRaw = account.config.groupPolicy === "blocked" ? "disabled" : (account.config.groupPolicy ?? "allowlist");
  const groupPolicy =
    allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const dmEnabled = account.config.dm?.enabled ?? true;
  const dmPolicyRaw = account.config.dm?.policy ?? "pairing";
  const dmPolicy =
    allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const roomConfigInfo = resolveMatrixRoomConfig({
    rooms: account.config.rooms ?? account.config.groups,
    roomId: event.roomId,
    aliases: event.roomAlias ? [event.roomAlias] : [],
  });
  let isDirectMessage = event.chatType === "direct";
  if (shouldOverrideDmToGroup({ isDirectMessage, roomConfigInfo })) {
    isDirectMessage = false;
  }
  const isRoom = !isDirectMessage;
  const roomConfig = isRoom ? roomConfigInfo.config : undefined;

  if (isRoom) {
    const routeAccess = evaluateGroupRouteAccessForPolicy({
      groupPolicy: groupPolicy as "open" | "allowlist" | "disabled",
      routeAllowlistConfigured: Boolean(roomConfigInfo.allowlistConfigured),
      routeMatched: Boolean(roomConfigInfo.config),
      routeEnabled: roomConfigInfo.allowed,
    });
    if (!routeAccess.allowed) {
      return;
    }
  }

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

  const pairing = createScopedPairingAccess({
    core: runtime,
    channel: "matrix",
    accountId: account.accountId,
  });
  const mentionRegexes = runtime.channel.mentions.buildMentionRegexes(cfg, route.agentId);
  const explicitMention = detectExplicitMention(event, diagnostics.userId);
  const senderName = event.senderName ?? event.senderId;
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
  const { access, effectiveAllowFrom, effectiveGroupAllowFrom, groupAllowConfigured } =
    await resolveMatrixAccessState({
      isDirectMessage,
      resolvedAccountId: pairing.accountId,
      dmPolicy: dmPolicy as "open" | "pairing" | "allowlist" | "disabled",
      groupPolicy: groupPolicy as "open" | "allowlist" | "disabled",
      allowFrom: account.config.dm?.allowFrom ?? [],
      groupAllowFrom: account.config.groupAllowFrom ?? [],
      senderId: event.senderId,
      readStoreForDmPolicy: pairing.readStoreForDmPolicy,
    });
  if (isDirectMessage) {
    const allowed = await enforceMatrixDirectMessageAccess({
      dmEnabled,
      dmPolicy: dmPolicy as "open" | "pairing" | "allowlist" | "disabled",
      accessDecision: access.decision,
      senderId: event.senderId,
      senderName,
      effectiveAllowFrom,
      upsertPairingRequest: pairing.upsertPairingRequest,
      sendPairingReply: async (text) => {
        client.sendMessage({
          roomId: event.roomId,
          text,
        });
      },
      logVerboseMessage: (message) => log?.info?.(message),
    });
    if (!allowed) {
      return;
    }
  }

  const roomUsers = roomConfig?.users ?? [];
  if (isRoom && roomUsers.length > 0) {
    const userMatch = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(roomUsers),
      userId: event.senderId,
    });
    if (!userMatch.allowed) {
      log?.debug?.(
        `[matrix:${account.accountId}] blocked sender ${event.senderId} (${formatAllowlistMatchMeta(userMatch)})`,
      );
      return;
    }
  }
  if (isRoom && roomUsers.length === 0 && groupAllowConfigured && access.decision !== "allow") {
    const groupAllowMatch = resolveMatrixAllowListMatch({
      allowList: effectiveGroupAllowFrom,
      userId: event.senderId,
    });
    if (!groupAllowMatch.allowed) {
      log?.debug?.(
        `[matrix:${account.accountId}] blocked sender ${event.senderId} (${formatAllowlistMatchMeta(groupAllowMatch)})`,
      );
      return;
    }
  }

  const wasMentioned =
    isDirectMessage
      ? true
      : runtime.channel.mentions.matchesMentionWithExplicit({
          text: baseBodyText,
          mentionRegexes,
          explicitWasMentioned: explicitMention,
        });
  const allowTextCommands = runtime.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: "matrix",
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = resolveMatrixAllowListMatches({
    allowList: effectiveAllowFrom,
    userId: event.senderId,
  });
  const senderAllowedForGroup = groupAllowConfigured
    ? resolveMatrixAllowListMatches({
        allowList: effectiveGroupAllowFrom,
        userId: event.senderId,
      })
    : false;
  const senderAllowedForRoomUsers =
    isRoom && roomUsers.length > 0
      ? resolveMatrixAllowListMatches({
          allowList: normalizeMatrixAllowList(roomUsers),
          userId: event.senderId,
        })
      : false;
  const hasControlCommandInMessage = runtime.channel.text.hasControlCommand(baseBodyText, cfg);
  const resolvedCommandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
      { configured: roomUsers.length > 0, allowed: senderAllowedForRoomUsers },
      { configured: groupAllowConfigured, allowed: senderAllowedForGroup },
    ],
    allowTextCommands,
    hasControlCommand: hasControlCommandInMessage,
  });
  if (isRoom && resolvedCommandGate.shouldBlock) {
    logInboundDrop({
      log: (message: string) => log?.info?.(message),
      channel: "matrix",
      reason: "control command (unauthorized)",
      target: event.senderId,
    });
    return;
  }
  const requireMention = shouldRequireMention(roomConfig, isDirectMessage);
  const shouldBypassMention =
    allowTextCommands &&
    isRoom &&
    requireMention &&
    !wasMentioned &&
    !explicitMention &&
    resolvedCommandGate.commandAuthorized &&
    hasControlCommandInMessage;
  bufferInboundHistory({
    sessionKey: route.sessionKey,
    event: {
      ...event,
      body: bodyText,
    },
    maxEntries: resolveRoomHistoryMaxEntries(account),
  });
  await recordInboundEmojiUsage({ client, event });
  if (isRoom && requireMention && !wasMentioned && !shouldBypassMention) {
    return;
  }
  const inboundHistory = consumeInboundHistory(route.sessionKey);

  const media = [
    ...(await saveInboundMedia({ account, client, event })),
    ...previewMedia,
  ];
  const conversationLabel = isDirectMessage
    ? senderName
    : (event.roomName ?? event.roomAlias ?? event.roomId);
  const threadTarget = resolveThreadTarget(account, event);
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: bodyText,
    BodyForAgent: bodyText,
    InboundHistory: inboundHistory.length > 0 ? inboundHistory : undefined,
    RawBody: baseBodyText,
    CommandBody: baseBodyText,
    From: isDirectMessage ? `matrix:${event.senderId}` : `matrix:channel:${event.roomId}`,
    To: `room:${event.roomId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: threadTarget ? "thread" : isDirectMessage ? "direct" : "channel",
    ConversationLabel: conversationLabel,
    SenderName: senderName,
    SenderId: event.senderId,
    WasMentioned: isDirectMessage ? undefined : (wasMentioned || shouldBypassMention),
    Provider: "matrix",
    Surface: "matrix",
    MessageSid: event.eventId,
    ReplyToId: threadTarget ? undefined : event.replyToId,
    MessageThreadId: threadTarget,
    Timestamp: eventTimestamp,
    MediaPath: media[0]?.path,
    MediaPaths: media.length > 0 ? media.map((item) => item.path) : undefined,
    MediaType: media[0]?.contentType,
    MediaTypes: media.length > 0 ? media.map((item) => item.contentType) : undefined,
    MediaUrl: media[0]?.path,
    MediaUrls: media.length > 0 ? media.map((item) => item.path) : undefined,
    GroupSubject: isDirectMessage ? undefined : conversationLabel,
    GroupChannel: isDirectMessage ? undefined : (event.roomAlias ?? event.roomId),
    GroupSystemPrompt: isDirectMessage ? undefined : roomConfig?.systemPrompt?.trim() || undefined,
    CommandAuthorized: resolvedCommandGate.commandAuthorized,
    CommandSource: "text",
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

  const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
  const ackScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const canDetectMention = mentionRegexes.length > 0 || explicitMention;
  const shouldAckReaction = Boolean(
    ackReaction &&
      runtime.channel.reactions?.shouldAckReaction?.({
        scope: ackScope,
        isDirect: isDirectMessage,
        isGroup: isRoom,
        isMentionableGroup: isRoom,
        requireMention,
        canDetectMention,
        effectiveWasMentioned: wasMentioned || shouldBypassMention,
        shouldBypassMention,
      }),
  );
  if (shouldAckReaction) {
    client.reactMessage({
      roomId: event.roomId,
      messageId: event.eventId,
      key: ackReaction,
    });
  }

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "matrix",
    accountId: route.accountId,
  });
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      client.setTyping({ roomId: event.roomId, typing: true });
    },
    stop: async () => {
      client.setTyping({ roomId: event.roomId, typing: false });
    },
    onStartError: (err: unknown) => {
      log?.info?.(`[matrix:${account.accountId}] typing start failed for ${event.roomId}: ${String(err)}`);
    },
    onStopError: (err: unknown) => {
      log?.info?.(`[matrix:${account.accountId}] typing stop failed for ${event.roomId}: ${String(err)}`);
    },
  });
  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: runtime.channel.reply.resolveHumanDelayConfig?.(cfg, route.agentId),
      typingCallbacks,
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
    });

  const { queuedFinal, counts } = await dispatchReplyFromConfigWithSettledDispatcher({
    cfg,
    ctxPayload,
    dispatcher,
    onSettled: () => {
      markDispatchIdle();
    },
    replyOptions: {
      ...replyOptions,
      skillFilter: roomConfig?.skills,
      onModelSelected,
    },
  });
  if (!queuedFinal) {
    return;
  }
  log?.debug?.(
    `[matrix:${account.accountId}] delivered ${counts.final} reply${counts.final === 1 ? "" : "ies"} to room:${event.roomId}`,
  );
  runtime.system.enqueueSystemEvent?.(
    `Matrix message from ${senderName}: ${baseBodyText.replace(/\s+/g, " ").slice(0, 160)}`,
    {
      sessionKey: route.sessionKey,
      contextKey: `matrix:message:${event.roomId}:${event.eventId || "unknown"}`,
    },
  );
}
