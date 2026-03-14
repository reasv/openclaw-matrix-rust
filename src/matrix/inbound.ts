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
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveControlCommandGate,
  resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/matrix";
import type {
  CoreConfig,
  MatrixInboundEvent,
  MatrixMessageSummary,
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
import {
  buildMatrixAttachmentTextBlocks,
  buildMatrixEnrichedBodyText,
  buildMatrixEventContextLine,
  resolveMatrixBodyForAgent,
  resolveMatrixInboundSenderLabel,
  resolveMatrixReadableBody,
  resolveMatrixSenderUsername,
} from "./inbound-format.js";
import {
  buildMatrixHistoryScopeKey,
  type MatrixRoomHistoryBuffer,
} from "./history-buffer.js";
import { resolveMatrixRoomConfig } from "./rooms.js";

const DEFAULT_STARTUP_GRACE_MS = 5_000;

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

export function detectExplicitMention(
  event: MatrixInboundEvent,
  diagnosticsUserId: string,
): boolean {
  if (event.mentions?.room) {
    return true;
  }
  if (!diagnosticsUserId) {
    return false;
  }
  return event.mentions?.userIds?.includes(diagnosticsUserId) ?? false;
}

export function buildMatrixInboundPresentation(params: {
  event: Pick<
    MatrixInboundEvent,
    | "senderId"
    | "senderName"
    | "body"
    | "msgtype"
    | "formattedBody"
    | "roomId"
    | "eventId"
    | "threadRootId"
    | "replyToId"
    | "media"
  >;
  isDirectMessage: boolean;
  conversationLabel: string;
  attachmentTextBlocks?: string[];
  replyToBody?: string;
  replyToSender?: string;
  replyAttachmentTextBlocks?: string[];
  replyPreviewTextBlocks?: string[];
  previewTextBlocks: string[];
  eventTimestamp?: number;
  previousTimestamp?: number;
  envelopeOptions?: unknown;
  formatInboundEnvelope: (params: {
    channel: string;
    from: string;
    timestamp?: number;
    previousTimestamp?: number;
    envelope?: unknown;
    body: string;
    chatType: "direct" | "channel";
    senderLabel: string;
  }) => string;
}): {
  senderName: string;
  senderUsername?: string;
  senderLabel: string;
  baseBodyText: string;
  bodyText: string;
  body: string;
  bodyForAgent: string;
} {
  const senderName = params.event.senderName ?? params.event.senderId;
  const senderUsername = resolveMatrixSenderUsername(params.event.senderId);
  const senderLabel = resolveMatrixInboundSenderLabel({
    senderName,
    senderId: params.event.senderId,
    senderUsername,
  });
  const baseBodyText = resolveMatrixReadableBody({
    body: params.event.body,
    formattedBody: params.event.formattedBody,
    msgtype: params.event.msgtype,
  });
  const bodyText = buildMatrixEnrichedBodyText({
    baseBodyText,
    attachmentTextBlocks: params.attachmentTextBlocks,
    replyToId: params.event.replyToId,
    replyToBody: params.replyToBody,
    replyToSender: params.replyToSender,
    replyAttachmentTextBlocks: params.replyAttachmentTextBlocks,
    replyPreviewTextBlocks: params.replyPreviewTextBlocks,
    previewTextBlocks: params.previewTextBlocks,
    eventContextLine: buildMatrixEventContextLine({
      roomId: params.event.roomId,
      eventId: params.event.eventId,
      threadRootId: params.event.threadRootId,
    }),
  });
  const body = params.formatInboundEnvelope({
    channel: "Matrix",
    from: params.conversationLabel,
    timestamp: Number.isFinite(params.eventTimestamp) ? params.eventTimestamp : undefined,
    previousTimestamp: params.previousTimestamp,
    envelope: params.envelopeOptions,
    body: bodyText,
    chatType: params.isDirectMessage ? "direct" : "channel",
    senderLabel,
  });
  return {
    senderName,
    senderUsername,
    senderLabel,
    baseBodyText,
    bodyText,
    body,
    bodyForAgent: resolveMatrixBodyForAgent({
      isDirectMessage: params.isDirectMessage,
      bodyText,
      senderLabel,
    }),
  };
}

function consumeInboundHistory(params: {
  roomHistory: MatrixRoomHistoryBuffer;
  scopeKey: string;
}): Array<{ sender: string; body: string; timestamp?: number }> {
  const buffered = params.roomHistory.snapshot(params.scopeKey);
  params.roomHistory.clear(params.scopeKey);
  return buffered.slice(0, -1);
}

export async function resolveMatrixReplyContext(params: {
  account: ResolvedMatrixAccount;
  client: MatrixNativeClient;
  roomId: string;
  replyToId?: string;
  replySummary: MatrixMessageSummary | null;
  persistPreviewMedia?: typeof savePreviewMedia;
  log?: { debug?: (message: string) => void };
}): Promise<{
  replyToBody?: string;
  replyToSender?: string;
  replyAttachmentTextBlocks: string[];
  replyPreviewTextBlocks: string[];
  replyPreviewMedia: Array<{ path: string; contentType?: string }>;
}> {
  const replyToBody = params.replySummary?.body?.trim() || undefined;
  if (!params.replySummary || !replyToBody) {
    return {
      replyToBody,
      replyToSender: undefined,
      replyAttachmentTextBlocks: [],
      replyPreviewTextBlocks: [],
      replyPreviewMedia: [],
    };
  }

  let replyToSender = params.replySummary.sender?.trim() || undefined;
  if (replyToSender) {
    try {
      const member = params.client.memberInfo({
        roomId: params.roomId,
        userId: replyToSender,
      });
      replyToSender = member.displayName?.trim() || replyToSender;
    } catch (err) {
      params.log?.debug?.(
        `[matrix:${params.account.accountId}] failed to resolve reply sender ${replyToSender}: ${String(err)}`,
      );
    }
  }

  let replyPreviewTextBlocks: string[] = [];
  let replyPreviewMedia: Array<{ path: string; contentType?: string }> = [];
  try {
    const previewResult = params.client.resolveLinkPreviews({
      bodyText: replyToBody,
      maxBytes: resolveMediaMaxBytes(params.account),
      includeImages: true,
      xPreviewViaFxTwitter: params.account.config.xPreviewViaFxTwitter === true,
    });
    replyPreviewTextBlocks = previewResult.textBlocks;
    replyPreviewMedia = await (params.persistPreviewMedia ?? savePreviewMedia)({
      account: params.account,
      media: previewResult.media,
    });
  } catch (err) {
    params.log?.debug?.(
      `[matrix:${params.account.accountId}] reply preview resolution failed for ${params.replyToId ?? "unknown"}: ${String(err)}`,
    );
  }

  return {
    replyToBody,
    replyToSender,
    replyAttachmentTextBlocks: [],
    replyPreviewTextBlocks,
    replyPreviewMedia,
  };
}

export async function resolveMatrixThreadContext(params: {
  account: ResolvedMatrixAccount;
  client: MatrixNativeClient;
  roomId: string;
  threadRootId?: string;
  threadSessionExists: boolean;
  conversationLabel: string;
  parentSessionKey: string;
  envelopeOptions?: unknown;
  formatAgentEnvelope: (params: {
    channel: string;
    from: string;
    timestamp?: string | number | Date;
    envelope?: unknown;
    body: string;
  }) => string;
  log?: { debug?: (message: string) => void };
}): Promise<{
  threadStarterBody?: string;
  threadLabel?: string;
  parentSessionKey?: string;
}> {
  if (!params.threadRootId || params.threadSessionExists) {
    return {};
  }

  try {
    const rootEvent = params.client.messageSummary({
      roomId: params.roomId,
      eventId: params.threadRootId,
    });
    if (!rootEvent?.body) {
      return {};
    }

    let threadFrom = rootEvent.sender ?? "Unknown";
    if (rootEvent.sender) {
      try {
        const member = params.client.memberInfo({
          roomId: params.roomId,
          userId: rootEvent.sender,
        });
        threadFrom = member.displayName?.trim() || threadFrom;
      } catch (err) {
        params.log?.debug?.(
          `[matrix:${params.account.accountId}] failed to resolve thread starter sender ${rootEvent.sender}: ${String(err)}`,
        );
      }
    }

    return {
      threadStarterBody: params.formatAgentEnvelope({
        channel: "Matrix",
        from: threadFrom,
        timestamp: rootEvent.timestamp,
        envelope: params.envelopeOptions,
        body: rootEvent.body,
      }),
      threadLabel: `Matrix thread in ${params.conversationLabel}`,
      parentSessionKey: params.parentSessionKey,
    };
  } catch (err) {
    params.log?.debug?.(
      `[matrix:${params.account.accountId}] failed to resolve thread starter ${params.threadRootId}: ${String(err)}`,
    );
    return {};
  }
}

export function resolveGroupPolicy(params: {
  cfg: CoreConfig;
  account: ResolvedMatrixAccount;
}): "open" | "allowlist" | "disabled" {
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.matrix !== undefined,
    groupPolicy: params.account.config.groupPolicy,
    defaultGroupPolicy,
  });
  return groupPolicy === "blocked" ? "disabled" : groupPolicy;
}

export function extractMatrixCustomEmojiUsageFromFormattedBody(
  formattedBody: string,
): Array<{ mxcUrl: string; shortcode: string }> {
  const imgTagPattern = /<img\b[^>]*>/gis;
  const attrPattern =
    /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gis;
  const entries = new Map<string, { mxcUrl: string; shortcode: string }>();
  const normalizeShortcode = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    if (/^:[^:\s]+:$/.test(trimmed)) {
      return trimmed;
    }
    if (/^[A-Za-z0-9_+\-]+$/.test(trimmed)) {
      return `:${trimmed}:`;
    }
    return trimmed;
  };

  for (const match of formattedBody.matchAll(imgTagPattern)) {
    const rawTag = match[0] ?? "";
    if (!/data-mx-emoticon/i.test(rawTag)) {
      continue;
    }

    let mxcUrl = "";
    let shortcode = "";
    let title = "";
    for (const captures of rawTag.matchAll(attrPattern)) {
      const name = (captures[1] ?? "").toLowerCase();
      const value = captures[2] ?? captures[3] ?? "";
      if ((name === "src" || name === "data-mx-src") && !mxcUrl) {
        mxcUrl = value;
      } else if (name === "alt" && !shortcode) {
        shortcode = value;
      } else if (name === "title" && !title) {
        title = value;
      }
    }

    shortcode = normalizeShortcode(shortcode || title);
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
  mediaLocalRoots?: readonly string[];
  runtime: any;
}): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
  const { mediaUrl, maxBytes, mediaLocalRoots, runtime } = params;
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

  const loaded = await runtime.media.loadWebMedia(mediaUrl, {
    maxBytes,
    localRoots: mediaLocalRoots,
  });
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
  mediaLocalRoots?: readonly string[];
  replyToId?: string;
  threadId?: string;
}): Promise<{ channel: "matrix"; to: string; messageId: string }> {
  const runtime = getMatrixRustRuntime() as any;
  const maxBytes = resolveMediaMaxBytes(params.account);
  const loaded = await loadOutboundMedia({
    mediaUrl: params.mediaUrl,
    maxBytes,
    mediaLocalRoots: params.mediaLocalRoots,
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
  roomHistory: MatrixRoomHistoryBuffer;
  log?: { info?: (message: string) => void; debug?: (message: string) => void };
}): Promise<void> {
  const { cfg, account, client, event, roomHistory, log } = params;
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
  const groupPolicyRaw = resolveGroupPolicy({ cfg, account });
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
  const explicitMention = detectExplicitMention(event, diagnostics.userId);
  const senderName = event.senderName ?? event.senderId;
  const senderLabel = resolveMatrixInboundSenderLabel({
    senderName,
    senderId: event.senderId,
    senderUsername: resolveMatrixSenderUsername(event.senderId),
  });
  const baseBodyText = resolveMatrixReadableBody({
    body: event.body,
    formattedBody: event.formattedBody,
    msgtype: event.msgtype,
  });
  let replySummary: MatrixMessageSummary | null = null;
  if (event.replyToId) {
    try {
      replySummary = client.messageSummary({
        roomId: event.roomId,
        eventId: event.replyToId,
      });
    } catch (err) {
      log?.debug?.(
        `[matrix:${account.accountId}] failed to resolve reply target ${event.replyToId}: ${String(err)}`,
      );
    }
  }
  const replyContext = await resolveMatrixReplyContext({
    account,
    client,
    roomId: event.roomId,
    replyToId: event.replyToId,
    replySummary,
    log,
  });
  const replyToBody = replyContext.replyToBody;
  const replyToSender = replyContext.replyToSender;
  const attachmentTextBlocks = buildMatrixAttachmentTextBlocks({
    attachments: event.media,
  });
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
  const historyBodyText = buildMatrixEnrichedBodyText({
    baseBodyText,
    attachmentTextBlocks,
    replyToId: event.replyToId,
    replyToBody,
    replyToSender,
    replyAttachmentTextBlocks: replyContext.replyAttachmentTextBlocks,
    replyPreviewTextBlocks: replyContext.replyPreviewTextBlocks,
    previewTextBlocks,
    eventContextLine: buildMatrixEventContextLine({
      roomId: event.roomId,
      eventId: event.eventId,
      threadRootId: event.threadRootId,
    }),
  });
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

  const wasMentioned = isDirectMessage ? true : explicitMention;
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
  const effectiveWasMentioned = wasMentioned || shouldBypassMention;
  const historyScopeKey = buildMatrixHistoryScopeKey({
    accountId: account.accountId,
    roomId: event.roomId,
    threadRootId: event.threadRootId,
  });
  if (isRoom) {
    roomHistory.add(historyScopeKey, {
      sender: senderLabel,
      body: historyBodyText,
      timestamp: Number.isFinite(eventTimestamp) ? eventTimestamp : undefined,
    });
  }
  await recordInboundEmojiUsage({ client, event });
  if (isRoom && requireMention && !effectiveWasMentioned) {
    return;
  }
  const inboundHistory =
    isRoom
      ? consumeInboundHistory({
          roomHistory,
          scopeKey: historyScopeKey,
        })
      : [];

  const media = [
    ...(await saveInboundMedia({ account, client, event })),
    ...replyContext.replyPreviewMedia,
    ...previewMedia,
  ];
  const conversationLabel = isDirectMessage
    ? (event.senderName ?? event.senderId)
    : (event.roomName ?? event.roomAlias ?? event.roomId);
  const threadTarget = resolveThreadTarget(account, event);
  const storePath = runtime.channel.session.resolveStorePath((cfg as any).session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt?.({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions?.(cfg);
  const threadContext = await resolveMatrixThreadContext({
    account,
    client,
    roomId: event.roomId,
    threadRootId: event.threadRootId,
    threadSessionExists: previousTimestamp !== undefined,
    conversationLabel,
    parentSessionKey: routeSession.sessionKey,
    envelopeOptions,
    formatAgentEnvelope: runtime.channel.reply.formatAgentEnvelope,
    log,
  });
  const presentation = buildMatrixInboundPresentation({
    event,
    isDirectMessage,
    conversationLabel,
    attachmentTextBlocks,
    replyToBody,
    replyToSender,
    replyAttachmentTextBlocks: replyContext.replyAttachmentTextBlocks,
    replyPreviewTextBlocks: replyContext.replyPreviewTextBlocks,
    previewTextBlocks,
    eventTimestamp,
    previousTimestamp,
    envelopeOptions,
    formatInboundEnvelope: runtime.channel.reply.formatInboundEnvelope,
  });
  const senderUsername = presentation.senderUsername;
  const bodyText = presentation.bodyText;
  const body = presentation.body;
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: presentation.bodyForAgent,
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
    SenderUsername: senderUsername,
    WasMentioned: isDirectMessage ? undefined : effectiveWasMentioned,
    Provider: "matrix",
    Surface: "matrix",
    MessageSid: event.eventId,
    ReplyToId: threadTarget ? undefined : event.replyToId,
    ReplyToBody: threadTarget ? undefined : replyToBody,
    ReplyToSender: threadTarget ? undefined : replyToSender,
    ReplyLinkPreviews:
      !threadTarget && replyContext.replyPreviewTextBlocks.length > 0
        ? replyContext.replyPreviewTextBlocks
        : undefined,
    ReplyMediaPaths:
      !threadTarget && replyContext.replyPreviewMedia.length > 0
        ? replyContext.replyPreviewMedia.map((item) => item.path)
        : undefined,
    ReplyMediaUrls:
      !threadTarget && replyContext.replyPreviewMedia.length > 0
        ? replyContext.replyPreviewMedia.map((item) => item.path)
        : undefined,
    ReplyMediaTypes:
      !threadTarget && replyContext.replyPreviewMedia.length > 0
        ? replyContext.replyPreviewMedia.map((item) => item.contentType ?? "")
        : undefined,
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
    ThreadStarterBody: threadContext.threadStarterBody,
    ThreadLabel: threadContext.threadLabel,
    ParentSessionKey: threadContext.parentSessionKey,
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
  const canDetectMention = true;
  const shouldAckReaction = Boolean(
    ackReaction &&
      runtime.channel.reactions?.shouldAckReaction?.({
        scope: ackScope,
        isDirect: isDirectMessage,
        isGroup: isRoom,
        isMentionableGroup: isRoom,
        requireMention,
        canDetectMention,
        effectiveWasMentioned,
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
