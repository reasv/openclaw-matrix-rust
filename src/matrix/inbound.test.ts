import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMatrixInboundPresentation,
  buildMatrixPromptImages,
  detectExplicitMention,
  extractMatrixCustomEmojiUsageFromFormattedBody,
  filterMatrixMediaForContext,
  handleMatrixInboundEvent,
  resolveMatrixReplyContext,
  resolveMatrixThreadContext,
  resolveGroupPolicy,
  sendMatrixMedia,
} from "./inbound.js";
import {
  buildMatrixAttachmentTextBlocks,
  buildMatrixEnrichedBodyText,
  buildMatrixEventContextLine,
  renderMatrixFormattedBody,
  resolveMatrixBodyForAgent,
  resolveMatrixInboundSenderLabel,
  resolveMatrixReadableBody,
} from "./inbound-format.js";
import { createMatrixRoomHistoryBuffer } from "./history-buffer.js";
import type { CoreConfig, MatrixInboundEvent, ResolvedMatrixAccount } from "../types.js";
import { setMatrixRustRuntime } from "../runtime.js";

function createResolvedAccount(
  config: ResolvedMatrixAccount["config"] = {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
  } as ResolvedMatrixAccount["config"],
): ResolvedMatrixAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    authMode: "password",
    config,
  };
}

function createRecordStopError() {
  return new Error("stop after record");
}

function createRuntimeForInboundTests(params: {
  onRecordInboundSession: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  return {
    state: {
      resolveStateDir: () => "/tmp/openclaw-matrix-rust-state",
    },
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: "main",
          accountId: "default",
          sessionKey: "agent:main:matrix:channel:!room:example.org",
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: "session",
        }),
        buildAgentSessionKey: () => "agent:main:matrix:channel:!room:example.org",
      },
      pairing: {
        readAllowFromStore: async () => [],
        upsertPairingRequest: async () => ({
          code: "PAIR",
          created: true,
        }),
      },
      commands: {
        shouldHandleTextCommands: () => true,
      },
      text: {
        hasControlCommand: () => false,
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-matrix-rust-session.json",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: params.onRecordInboundSession,
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatInboundEnvelope: (ctx: { senderLabel: string; body: string }) =>
          `${ctx.senderLabel}: ${ctx.body}`,
        formatAgentEnvelope: (ctx: { from: string; body: string }) => `${ctx.from}: ${ctx.body}`,
        finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
      },
    },
  } as any;
}

function createClientForInboundTests() {
  return {
    diagnostics: () => ({
      accountId: "default",
      userId: "@bot:example.org",
      deviceId: "DEVICE",
      verificationState: "verified",
      keyBackupState: "enabled",
      syncState: "ready",
      lastSuccessfulSyncAt: null,
      lastSuccessfulDecryptionAt: null,
      startedAt: null,
    }),
    resolveLinkPreviews: () => ({
      textBlocks: [],
      media: [],
      sources: [],
    }),
    recordCustomEmojiUsage: () => undefined,
  } as any;
}

function createInboundEvent(overrides: Partial<MatrixInboundEvent> = {}): MatrixInboundEvent {
  return {
    roomId: "!room:example.org",
    eventId: "$event",
    senderId: "@alice:example.org",
    senderName: "Alice",
    roomName: "Dev Room",
    roomAlias: "#dev:example.org",
    chatType: "channel",
    body: "hello",
    msgtype: "m.text",
    timestamp: new Date().toISOString(),
    media: [],
    ...overrides,
  };
}

test("extracts custom emoji regardless of attribute order", () => {
  const entries = extractMatrixCustomEmojiUsageFromFormattedBody(
    '<p><img alt=":blobwave:" title=":blobwave:" data-mx-emoticon src="mxc://example.org/blobwave" /></p>',
  );

  assert.deepEqual(entries, [
    {
      mxcUrl: "mxc://example.org/blobwave",
      shortcode: ":blobwave:",
    },
  ]);
});

test("extracts custom emoji from title-only markup and normalizes bare titles", () => {
  const entries = extractMatrixCustomEmojiUsageFromFormattedBody(
    '<p><img data-mx-emoticon src="mxc://example.org/ohman" title="ohman" /></p>',
  );

  assert.deepEqual(entries, [
    {
      mxcUrl: "mxc://example.org/ohman",
      shortcode: ":ohman:",
    },
  ]);
});

test("ignores non-emoticon images and deduplicates matches", () => {
  const entries = extractMatrixCustomEmojiUsageFromFormattedBody(
    [
      '<img src="mxc://example.org/blobwave" alt=":blobwave:" data-mx-emoticon />',
      '<img data-mx-emoticon alt=":blobwave:" src="mxc://example.org/blobwave" />',
      '<img src="mxc://example.org/plain" alt=":plain:" />',
    ].join(""),
  );

  assert.deepEqual(entries, [
    {
      mxcUrl: "mxc://example.org/blobwave",
      shortcode: ":blobwave:",
    },
  ]);
});

test("detects explicit mentions from m.mentions", () => {
  const event: MatrixInboundEvent = {
    roomId: "!room:example.org",
    eventId: "$event",
    senderId: "@alice:example.org",
    chatType: "channel",
    body: "OpenClaw please check this",
    mentions: {
      userIds: ["@bot:example.org"],
    },
    timestamp: new Date().toISOString(),
    media: [],
  };

  assert.equal(detectExplicitMention(event, "@bot:example.org"), true);
});

test("inherits matrix room policy from channel defaults when account policy is unset", () => {
  const cfg: CoreConfig = {
    channels: {
      defaults: {
        groupPolicy: "open",
      },
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
      },
    },
  } as CoreConfig;
  const account: ResolvedMatrixAccount = {
    accountId: "default",
    enabled: true,
    configured: true,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    authMode: "password",
    config: cfg.channels?.matrix as ResolvedMatrixAccount["config"],
  };

  assert.equal(resolveGroupPolicy({ cfg, account }), "open");
});

test("renders formatted bodies with custom emoji placeholders", () => {
  assert.deepEqual(
    renderMatrixFormattedBody(
      'hello <img data-mx-emoticon src="mxc://matrix.example.org/party" alt=":party_parrot:">',
    ),
    {
      text: "hello :party_parrot:",
      hasCustomEmoji: true,
    },
  );
});

test("builds readable matrix bodies for current inbound messages", () => {
  assert.equal(
    resolveMatrixReadableBody({
      body: "mxc://matrix.example.org/party",
      formattedBody:
        'hello <img data-mx-emoticon src="mxc://matrix.example.org/party" alt=":party_parrot:">',
      msgtype: "m.text",
    }),
    "hello :party_parrot:",
  );
  assert.equal(
    resolveMatrixReadableBody({
      body: "waves",
      msgtype: "m.emote",
    }),
    "/me waves",
  );
});

test("labels group messages for BodyForAgent", () => {
  const senderLabel = resolveMatrixInboundSenderLabel({
    senderName: "Bu",
    senderId: "@bu:matrix.example.org",
  });
  assert.equal(senderLabel, "Bu (bu)");
  assert.equal(
    resolveMatrixBodyForAgent({
      isDirectMessage: false,
      bodyText: "show me my commits",
      senderLabel,
    }),
    "Bu (bu): show me my commits",
  );
});

test("stores readable BodyForAgent and enveloped Body for group thread messages", () => {
  const event: MatrixInboundEvent = {
    roomId: "!room:example.org",
    eventId: "$event",
    senderId: "@bu:matrix.example.org",
    senderName: "Bu",
    roomName: "Infra",
    roomAlias: "#infra:matrix.example.org",
    chatType: "thread",
    body: "mxc://matrix.example.org/party",
    msgtype: "m.text",
    formattedBody:
      'hello <img data-mx-emoticon src="mxc://matrix.example.org/party" alt=":party_parrot:">',
    mentions: {
      userIds: ["@bot:example.org"],
    },
    threadRootId: "$thread-root",
    timestamp: new Date().toISOString(),
    media: [],
  };
  const presentation = buildMatrixInboundPresentation({
    event,
    isDirectMessage: false,
    conversationLabel: "Infra",
    attachmentTextBlocks: [],
    previewTextBlocks: [],
    eventTimestamp: Date.now(),
    previousTimestamp: 123,
    envelopeOptions: {},
    formatInboundEnvelope: (params) => `formatted:${params.senderLabel}:${params.body}`,
  });

  assert.equal(presentation.senderUsername, "bu");
  assert.equal(presentation.senderLabel, "Bu (bu)");
  assert.equal(presentation.baseBodyText, "hello :party_parrot:");
  assert.equal(
    presentation.bodyForAgent,
    'Bu (bu): hello :party_parrot:\n[Matrix event] room="!room:example.org" event="$event" thread="$thread-root"',
  );
  assert.match(presentation.body, /^formatted:Bu \(bu\):hello :party_parrot:/);
  assert.match(presentation.body, /\[Matrix event\] room="!room:example\.org" event="\$event" thread="\$thread-root"/);
});

test("formats reply preview blocks separately from current-message previews", () => {
  assert.equal(
    buildMatrixEnrichedBodyText({
      baseBodyText: "current body",
      attachmentTextBlocks: ['[Attachments: 1]', '[Attachment 1] filename="photo.jpg" type="image/jpeg"'],
      replyToId: "$parent",
      replyToSender: "Alice",
      replyToBody: "look at https://x.com/example/status/1",
      replyAttachmentTextBlocks: ['[Reply attachments: 1]', '[Reply attachment 1] filename="reply.png" type="image/png"'],
      replyPreviewTextBlocks: ["[Tweet: Alice (@alice)]\nhello"],
      previewTextBlocks: ["[Link preview: example.org]\ncurrent preview"],
      eventContextLine: '[Matrix event] room="!room:example.org" event="$event"',
    }),
    [
      "current body",
      "[Attachments: 1]",
      '[Attachment 1] filename="photo.jpg" type="image/jpeg"',
      "[Replying to Alice id:$parent]",
      "look at https://x.com/example/status/1",
      "[Reply attachments: 1]",
      '[Reply attachment 1] filename="reply.png" type="image/png"',
      "[Reply link preview]",
      "[Tweet: Alice (@alice)]",
      "hello",
      "[Link preview: example.org]",
      "current preview",
      '[Matrix event] room="!room:example.org" event="$event"',
    ].join("\n"),
  );
});

test("builds stable attachment manifest text with fallback values", () => {
  assert.deepEqual(
    buildMatrixAttachmentTextBlocks({
      attachments: [
        {
          index: 0,
          filename: "photo.jpg",
          contentType: "image/jpeg",
          kind: "image",
        },
        {
          index: 1,
          kind: "file",
        },
      ],
    }),
    [
      "[Attachments: 2]",
      '[Attachment 1] filename="photo.jpg" type="image/jpeg"',
      '[Attachment 2] filename="file-2" type="application/octet-stream"',
    ],
  );
  assert.equal(
    buildMatrixEventContextLine({
      roomId: "!room:example.org",
      eventId: "$event",
      threadRootId: "$thread",
    }),
    '[Matrix event] room="!room:example.org" event="$event" thread="$thread"',
  );
});

test("includes saved workspace paths in attachment manifest text when present", () => {
  assert.deepEqual(
    buildMatrixAttachmentTextBlocks({
      attachments: [
        {
          index: 0,
          filename: "photo.jpg",
          contentType: "image/jpeg",
          kind: "image",
          savedTo: "./msg-attach/ABCDE12345.jpg",
        },
      ],
    }),
    [
      "[Attachments: 1]",
      '[Attachment 1] filename="photo.jpg" type="image/jpeg" saved to="./msg-attach/ABCDE12345.jpg"',
    ],
  );
});

test("resolves reply context with display names and one-hop previews", async () => {
  const cfg: CoreConfig = {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
        xPreviewViaFxTwitter: true,
      },
    },
  } as CoreConfig;
  const account: ResolvedMatrixAccount = {
    accountId: "default",
    enabled: true,
    configured: true,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    authMode: "password",
    config: cfg.channels?.matrix as ResolvedMatrixAccount["config"],
  };

  const replyContext = await resolveMatrixReplyContext({
    cfg,
    account,
    agentId: "main",
    isRoom: true,
    client: {
      memberInfo: ({ userId }: { userId: string }) => ({
        roomId: "!room:example.org",
        userId,
        displayName: "Alice",
        isSelf: false,
        isDirect: false,
      }),
      resolveLinkPreviews: ({ bodyText }: { bodyText: string }) => {
        assert.equal(bodyText, "look at https://x.com/example/status/1");
        return {
          textBlocks: ["[Tweet: Alice (@alice)]\nhello from x"],
          media: [
            {
              dataBase64: Buffer.from("reply-preview").toString("base64"),
              contentType: "image/png",
              filename: "reply-preview.png",
              sourceUrl: "https://example.org/reply-preview.png",
            },
          ],
          sources: [],
        };
      },
    } as any,
    roomId: "!room:example.org",
    replyToId: "$parent",
    replySummary: {
      eventId: "$parent",
      sender: "@alice:example.org",
      body: "look at https://x.com/example/status/1",
      timestamp: new Date().toISOString(),
    },
    persistPreviewMedia: async ({ media }) => {
      assert.equal(media.length, 1);
      return [{ path: "/tmp/reply-preview.png", contentType: media[0]?.contentType }];
    },
  });

  assert.equal(replyContext.replyToBody, "look at https://x.com/example/status/1");
  assert.equal(replyContext.replyToSender, "Alice");
  assert.deepEqual(replyContext.replyAttachmentTextBlocks, []);
  assert.deepEqual(replyContext.replyPreviewTextBlocks, ["[Tweet: Alice (@alice)]\nhello from x"]);
  assert.deepEqual(replyContext.replyPreviewMedia, [
    { path: "/tmp/reply-preview.png", contentType: "image/png" },
  ]);
});

test("resolves reply attachment manifests and reply image media", async () => {
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    autoDownloadAttachmentMaxBytes: -1,
  } as ResolvedMatrixAccount["config"]);
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-reply-attach-"));
  setMatrixRustRuntime({
    state: {
      resolveStateDir: () => "/tmp/openclaw-matrix-rust-state",
    },
  } as any);

  const replyContext = await resolveMatrixReplyContext({
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret",
          autoDownloadAttachmentMaxBytes: -1,
        },
      },
    } as CoreConfig,
    account,
    agentId: "main",
    isRoom: true,
    client: {
      downloadMedia: ({ eventId }: { eventId: string }) => {
        assert.equal(eventId, "$parent");
        return {
          roomId: "!room:example.org",
          eventId,
          kind: "image",
          filename: "reply-photo.png",
          contentType: "image/png",
          dataBase64: Buffer.from("reply-image").toString("base64"),
        };
      },
      memberInfo: ({ userId }: { userId: string }) => ({
        roomId: "!room:example.org",
        userId,
        displayName: "Alice",
        isSelf: false,
        isDirect: false,
      }),
      resolveLinkPreviews: () => ({
        textBlocks: [],
        media: [],
        sources: [],
      }),
    } as any,
    roomId: "!room:example.org",
    replyToId: "$parent",
    replySummary: {
      eventId: "$parent",
      sender: "@alice:example.org",
      body: "see attachment",
      timestamp: new Date().toISOString(),
    },
    persistPreviewMedia: async ({ media }) =>
      media.map((item, index) => ({
        path: `/tmp/reply-${index}.png`,
        filename: item.filename,
        kind: item.kind,
        contentType: item.contentType,
        promptImage: item.contentType?.startsWith("image/")
          ? {
              type: "image",
              data: item.dataBase64,
              mimeType: item.contentType,
            }
          : undefined,
      })),
  });

  assert.equal(replyContext.replyAttachmentTextBlocks[0], "[Reply attachments: 1]");
  assert.match(
    replyContext.replyAttachmentTextBlocks[1] ?? "",
    /^\[Reply attachment 1\] filename="reply-photo\.png" type="image\/png" saved to="\.\/msg-attach\/[A-Z2-7]{10}\.png"$/,
  );
  assert.deepEqual(replyContext.replyAttachmentMedia, [
    {
      path: "/tmp/reply-0.png",
      filename: "reply-photo.png",
      kind: "image",
      contentType: "image/png",
      promptImage: {
        type: "image",
        data: Buffer.from("reply-image").toString("base64"),
        mimeType: "image/png",
      },
    },
  ]);
  const replySavedName = (replyContext.replyAttachmentTextBlocks[1] ?? "").match(
    /saved to="\.\/msg-attach\/([^"]+)"/,
  )?.[1];
  assert.ok(replySavedName);
  const savedPath = path.join(workspaceDir, "msg-attach", replySavedName);
  assert.equal(await fs.readFile(savedPath, "utf8"), "reply-image");
});

test("filters MediaPaths separately from prompt image delivery", () => {
  const media = [
    {
      path: "/tmp/current-image.png",
      filename: "current-image.png",
      kind: "image",
      contentType: "image/png",
      promptImage: {
        type: "image" as const,
        data: "aW1hZ2U=",
        mimeType: "image/png",
      },
    },
    {
      path: "/tmp/report.pdf",
      filename: "report.pdf",
      kind: "file",
      contentType: "application/pdf",
    },
  ];

  const multimodalOnly = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    imageHandlingMode: "multimodal-only",
    otherMediaPaths: false,
  } as ResolvedMatrixAccount["config"]);
  assert.deepEqual(filterMatrixMediaForContext({ account: multimodalOnly, media }), []);
  assert.deepEqual(buildMatrixPromptImages({ account: multimodalOnly, media }), [
    {
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    },
  ]);

  const analysisOnly = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    imageHandlingMode: "analysis-only",
    otherMediaPaths: true,
  } as ResolvedMatrixAccount["config"]);
  assert.deepEqual(
    filterMatrixMediaForContext({ account: analysisOnly, media }).map((item) => item.path),
    ["/tmp/current-image.png", "/tmp/report.pdf"],
  );
  assert.deepEqual(buildMatrixPromptImages({ account: analysisOnly, media }), []);
});

test("resolves thread starter context for a new thread session", async () => {
  const cfg: CoreConfig = {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
      },
    },
  } as CoreConfig;
  const account: ResolvedMatrixAccount = {
    accountId: "default",
    enabled: true,
    configured: true,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    authMode: "password",
    config: cfg.channels?.matrix as ResolvedMatrixAccount["config"],
  };

  const threadContext = await resolveMatrixThreadContext({
    account,
    client: {
      messageSummary: ({ eventId }: { eventId: string }) => ({
        eventId,
        sender: "@alice:example.org",
        body: "root body",
        timestamp: "2026-03-14T12:00:00.000Z",
      }),
      memberInfo: ({ userId }: { userId: string }) => ({
        roomId: "!room:example.org",
        userId,
        displayName: "Alice",
        isSelf: false,
        isDirect: false,
      }),
    } as any,
    roomId: "!room:example.org",
    threadRootId: "$thread-root",
    threadSessionExists: false,
    conversationLabel: "Infra",
    parentSessionKey: "agent:main:matrix:channel:!room:example.org",
    envelopeOptions: {},
    formatAgentEnvelope: (params) => `thread:${params.from}:${params.body}`,
  });

  assert.deepEqual(threadContext, {
    threadStarterBody: "thread:Alice:root body",
    threadLabel: "Matrix thread in Infra",
    parentSessionKey: "agent:main:matrix:channel:!room:example.org",
  });
});

test("sendMatrixMedia forwards mediaLocalRoots for local workspace files", async () => {
  const loadWebMediaCalls: Array<{ mediaUrl: string; options: Record<string, unknown> }> = [];
  const fetchRemoteMediaCalls: unknown[] = [];
  const uploadMediaCalls: Array<Record<string, unknown>> = [];

  setMatrixRustRuntime({
    media: {
      loadWebMedia: async (mediaUrl: string, options?: Record<string, unknown>) => {
        loadWebMediaCalls.push({ mediaUrl, options: options ?? {} });
        return {
          buffer: Buffer.from("local-image"),
          contentType: "image/png",
          fileName: "render.png",
        };
      },
    },
    channel: {
      media: {
        fetchRemoteMedia: async (params: unknown) => {
          fetchRemoteMediaCalls.push(params);
          return {
            buffer: Buffer.from("remote-image"),
            contentType: "image/png",
            fileName: "remote.png",
          };
        },
      },
    },
  } as any);

  const result = await sendMatrixMedia({
    account: createResolvedAccount(),
    client: {
      uploadMedia: (request: Record<string, unknown>) => {
        uploadMediaCalls.push(request);
        return {
          roomId: "!room:example.org",
          messageId: "$media",
          filename: String(request.filename),
          contentType: String(request.contentType),
        };
      },
    } as any,
    to: "!room:example.org",
    mediaUrl: "/tmp/workspace-agent/out/render.png",
    mediaLocalRoots: ["/tmp/workspace-agent"],
    text: "caption",
  });

  assert.deepEqual(result, {
    channel: "matrix",
    to: "!room:example.org",
    messageId: "$media",
  });
  assert.deepEqual(loadWebMediaCalls, [
    {
      mediaUrl: "/tmp/workspace-agent/out/render.png",
      options: {
        maxBytes: 20 * 1024 * 1024,
        localRoots: ["/tmp/workspace-agent"],
      },
    },
  ]);
  assert.deepEqual(fetchRemoteMediaCalls, []);
  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "render.png",
      contentType: "image/png",
      dataBase64: Buffer.from("local-image").toString("base64"),
      caption: "caption",
      replyToId: undefined,
      threadId: undefined,
    },
  ]);
});

test("sendMatrixMedia keeps remote URL loading on the remote fetch path", async () => {
  const loadWebMediaCalls: unknown[] = [];
  const fetchRemoteMediaCalls: Array<Record<string, unknown>> = [];
  const uploadMediaCalls: Array<Record<string, unknown>> = [];

  setMatrixRustRuntime({
    media: {
      loadWebMedia: async (mediaUrl: string, options?: Record<string, unknown>) => {
        loadWebMediaCalls.push({ mediaUrl, options: options ?? {} });
        return {
          buffer: Buffer.from("unexpected"),
          contentType: "application/octet-stream",
          fileName: "unexpected.bin",
        };
      },
    },
    channel: {
      media: {
        fetchRemoteMedia: async (params: Record<string, unknown>) => {
          fetchRemoteMediaCalls.push(params);
          return {
            buffer: Buffer.from("remote-file"),
            contentType: "application/pdf",
            fileName: "report.pdf",
          };
        },
      },
    },
  } as any);

  const result = await sendMatrixMedia({
    account: createResolvedAccount(),
    client: {
      uploadMedia: (request: Record<string, unknown>) => {
        uploadMediaCalls.push(request);
        return {
          roomId: "!room:example.org",
          messageId: "$file",
          filename: String(request.filename),
          contentType: String(request.contentType),
        };
      },
    } as any,
    to: "!room:example.org",
    mediaUrl: "https://example.com/report.pdf",
    mediaLocalRoots: ["/tmp/workspace-agent"],
  });

  assert.deepEqual(result, {
    channel: "matrix",
    to: "!room:example.org",
    messageId: "$file",
  });
  assert.deepEqual(fetchRemoteMediaCalls, [
    {
      url: "https://example.com/report.pdf",
      maxBytes: 20 * 1024 * 1024,
    },
  ]);
  assert.deepEqual(loadWebMediaCalls, []);
  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "report.pdf",
      contentType: "application/pdf",
      dataBase64: Buffer.from("remote-file").toString("base64"),
      caption: undefined,
      replyToId: undefined,
      threadId: undefined,
    },
  ]);
});

test("buffers unmentioned room messages and flushes them on the next mention", async () => {
  const stopAfterRecord = createRecordStopError();
  const firstTimestamp = "2026-03-14T12:00:00.000Z";
  const recorded: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime(
    createRuntimeForInboundTests({
      onRecordInboundSession: async (payload) => {
        recorded.push(payload);
        throw stopAfterRecord;
      },
    }),
  );
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    groupPolicy: "open",
  } as ResolvedMatrixAccount["config"]);
  const client = createClientForInboundTests();

  await handleMatrixInboundEvent({
    cfg: {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret",
          groupPolicy: "open",
        },
      },
    } as CoreConfig,
    account,
    client,
    roomHistory,
    event: createInboundEvent({
      eventId: "$event-1",
      body: "just chatting",
      timestamp: firstTimestamp,
      media: [
        {
          index: 0,
          kind: "image",
          filename: "buffered.png",
          contentType: "image/png",
        },
      ],
    }),
  });

  assert.equal(recorded.length, 0);

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            password: "secret",
            groupPolicy: "open",
          },
        },
      } as CoreConfig,
      account,
      client,
      roomHistory,
      event: createInboundEvent({
        eventId: "$event-2",
        senderId: "@bu:example.org",
        senderName: "Bu",
        body: "@bot what do you think?",
        mentions: {
          userIds: ["@bot:example.org"],
        },
      }),
    }),
    /stop after record/,
  );

  assert.equal(recorded.length, 1);
  const ctx = recorded[0]?.ctx as Record<string, unknown>;
  assert.equal(
    ctx.BodyForAgent,
    'Bu (bu): @bot what do you think?\n[Matrix event] room="!room:example.org" event="$event-2"',
  );
  assert.deepEqual(ctx.InboundHistory, [
    {
      sender: "Alice (alice)",
      body: [
        "just chatting",
        "[Attachments: 1]",
        '[Attachment 1] filename="buffered.png" type="image/png"',
      ].join("\n"),
      timestamp: Date.parse(firstTimestamp),
    },
  ]);
  const retainedHistory = roomHistory.snapshot("default:!room:example.org");
  assert.equal(retainedHistory.length, 2);
  assert.deepEqual(retainedHistory[0], {
    sender: "Alice (alice)",
    body: [
      "just chatting",
      "[Attachments: 1]",
      '[Attachment 1] filename="buffered.png" type="image/png"',
    ].join("\n"),
    timestamp: Date.parse(firstTimestamp),
  });
  assert.equal(retainedHistory[1]?.sender, "Bu (bu)");
  assert.equal(retainedHistory[1]?.body, "@bot what do you think?");
  assert.equal(typeof retainedHistory[1]?.timestamp, "number");
});

test("clears buffered room history after inbound session recording succeeds", async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const runtime = createRuntimeForInboundTests({
    onRecordInboundSession: async (payload) => {
      recorded.push(payload);
    },
  });
  runtime.channel.reactions = {
    shouldAckReaction: () => true,
  };
  setMatrixRustRuntime(runtime);
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    groupPolicy: "open",
  } as ResolvedMatrixAccount["config"]);
  const client = {
    ...createClientForInboundTests(),
    reactMessage: () => {
      throw new Error("ack failed");
    },
  };

  await handleMatrixInboundEvent({
    cfg: {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret",
          groupPolicy: "open",
        },
      },
    } as CoreConfig,
    account,
    client,
    roomHistory,
    event: createInboundEvent({
      eventId: "$event-1",
      body: "just chatting",
      timestamp: "2026-03-14T12:00:00.000Z",
    }),
  });

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            password: "secret",
            groupPolicy: "open",
          },
        },
        messages: {
          ackReaction: "✅",
        },
      } as CoreConfig,
      account,
      client,
      roomHistory,
      event: createInboundEvent({
        eventId: "$event-2",
        senderId: "@bu:example.org",
        senderName: "Bu",
        body: "@bot what do you think?",
        mentions: {
          userIds: ["@bot:example.org"],
        },
      }),
    }),
    /ack failed/,
  );

  assert.equal(recorded.length, 1);
  assert.deepEqual(roomHistory.snapshot("default:!room:example.org"), []);
});

test("auto-downloads room attachments into the agent workspace and advertises relative paths", async () => {
  const stopAfterRecord = createRecordStopError();
  const recorded: Array<Record<string, unknown>> = [];
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-buffered-attach-"));
  const bufferedTimestamp = "2026-03-14T12:00:00.000Z";
  setMatrixRustRuntime(
    createRuntimeForInboundTests({
      onRecordInboundSession: async (payload) => {
        recorded.push(payload);
        throw stopAfterRecord;
      },
    }),
  );
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const cfg = {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
        groupPolicy: "open",
        autoDownloadAttachmentMaxBytes: -1,
      },
    },
  } as CoreConfig;
  const account = createResolvedAccount(cfg.channels?.matrix as ResolvedMatrixAccount["config"]);
  const client = {
    ...createClientForInboundTests(),
    downloadMedia: ({ eventId }: { eventId: string }) => {
      assert.equal(eventId, "$buffered-image");
      return {
        roomId: "!room:example.org",
        eventId,
        kind: "image",
        filename: "buffered.png",
        contentType: "image/png",
        dataBase64: Buffer.from("buffered-image").toString("base64"),
      };
    },
  } as any;

  await handleMatrixInboundEvent({
    cfg,
    account,
    client,
    roomHistory,
    event: createInboundEvent({
      eventId: "$buffered-image",
      body: "buffered image",
      timestamp: bufferedTimestamp,
      media: [
        {
          index: 0,
          kind: "image",
          filename: "buffered.png",
          contentType: "image/png",
        },
      ],
    }),
  });

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account,
      client,
      roomHistory,
      event: createInboundEvent({
        eventId: "$mentioned",
        senderId: "@bu:example.org",
        senderName: "Bu",
        body: "@bot take a look",
        mentions: {
          userIds: ["@bot:example.org"],
        },
      }),
    }),
    /stop after record/,
  );

  const ctx = recorded[0]?.ctx as Record<string, unknown>;
  const inboundHistory = ctx.InboundHistory as Array<{
    sender: string;
    body: string;
    timestamp?: number;
  }>;
  assert.equal(inboundHistory.length, 1);
  assert.equal(inboundHistory[0]?.sender, "Alice (alice)");
  assert.equal(inboundHistory[0]?.timestamp, Date.parse(bufferedTimestamp));
  assert.match(
    inboundHistory[0]?.body ?? "",
    /^buffered image\n\[Attachments: 1\]\n\[Attachment 1\] filename="buffered\.png" type="image\/png" saved to="\.\/msg-attach\/([A-Z2-7]{10}\.png)"$/,
  );
  const savedName = (inboundHistory[0]?.body ?? "").match(
    /saved to="\.\/msg-attach\/([^"]+)"/,
  )?.[1];
  assert.ok(savedName);
  const savedPath = path.join(workspaceDir, "msg-attach", savedName);
  assert.equal(await fs.readFile(savedPath, "utf8"), "buffered-image");
});

test("keeps thread history separate from room-main history", async () => {
  const stopAfterRecord = createRecordStopError();
  const roomTimestamp = "2026-03-14T12:05:00.000Z";
  const recorded: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime(
    createRuntimeForInboundTests({
      onRecordInboundSession: async (payload) => {
        recorded.push(payload);
        throw stopAfterRecord;
      },
    }),
  );
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    groupPolicy: "open",
  } as ResolvedMatrixAccount["config"]);
  const client = createClientForInboundTests();

  await handleMatrixInboundEvent({
    cfg: {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret",
          groupPolicy: "open",
        },
      },
    } as CoreConfig,
    account,
    client,
    roomHistory,
    event: createInboundEvent({
      eventId: "$event-room",
      body: "room chatter",
      timestamp: roomTimestamp,
    }),
  });

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            password: "secret",
            groupPolicy: "open",
          },
        },
      } as CoreConfig,
      account,
      client,
      roomHistory,
      event: createInboundEvent({
        eventId: "$event-thread",
        senderId: "@bu:example.org",
        senderName: "Bu",
        body: "@bot in thread",
        mentions: {
          userIds: ["@bot:example.org"],
        },
        threadRootId: "$thread-root",
      }),
    }),
    /stop after record/,
  );

  const ctx = recorded[0]?.ctx as Record<string, unknown>;
  assert.equal(ctx.InboundHistory, undefined);
});

test("does not leak pending room history across accounts sharing the same room id", async () => {
  const stopAfterRecord = createRecordStopError();
  const workTimestamp = "2026-03-14T12:10:00.000Z";
  const recorded: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime(
    createRuntimeForInboundTests({
      onRecordInboundSession: async (payload) => {
        recorded.push(payload);
        throw stopAfterRecord;
      },
    }),
  );
  const sharedRoomHistory = createMatrixRoomHistoryBuffer(5);
  const client = createClientForInboundTests();
  const workAccount = {
    ...createResolvedAccount({
      homeserver: "https://matrix.example.org",
      userId: "@workbot:example.org",
      password: "secret",
      groupPolicy: "open",
    } as ResolvedMatrixAccount["config"]),
    accountId: "work",
    userId: "@workbot:example.org",
  } satisfies ResolvedMatrixAccount;
  const personalAccount = {
    ...createResolvedAccount({
      homeserver: "https://matrix.example.org",
      userId: "@homebot:example.org",
      password: "secret",
      groupPolicy: "open",
    } as ResolvedMatrixAccount["config"]),
    accountId: "personal",
    userId: "@homebot:example.org",
  } satisfies ResolvedMatrixAccount;
  const cfg = {
    channels: {
      matrix: {
        defaultAccount: "work",
        accounts: {
          work: {
            homeserver: "https://matrix.example.org",
            userId: "@workbot:example.org",
            password: "secret",
            groupPolicy: "open",
          },
          personal: {
            homeserver: "https://matrix.example.org",
            userId: "@homebot:example.org",
            password: "secret",
            groupPolicy: "open",
          },
        },
      },
    },
  } as CoreConfig;

  await handleMatrixInboundEvent({
    cfg,
    account: workAccount,
    client,
    roomHistory: sharedRoomHistory,
    event: createInboundEvent({
      eventId: "$work-buffered",
      body: "from work account",
      timestamp: workTimestamp,
    }),
  });

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account: personalAccount,
      client,
      roomHistory: sharedRoomHistory,
      event: createInboundEvent({
        eventId: "$personal-mentioned",
        senderId: "@bu:example.org",
        senderName: "Bu",
        body: "@bot from personal account",
        mentions: {
          userIds: ["@bot:example.org"],
        },
      }),
    }),
    /stop after record/,
  );

  const personalCtx = recorded[0]?.ctx as Record<string, unknown>;
  assert.equal(personalCtx.InboundHistory, undefined);

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account: workAccount,
      client,
      roomHistory: sharedRoomHistory,
      event: createInboundEvent({
        eventId: "$work-mentioned",
        senderId: "@carol:example.org",
        senderName: "Carol",
        body: "@bot from work account",
        mentions: {
          userIds: ["@bot:example.org"],
        },
      }),
    }),
    /stop after record/,
  );

  const workCtx = recorded[1]?.ctx as Record<string, unknown>;
  assert.deepEqual(workCtx.InboundHistory, [
    {
      sender: "Alice (alice)",
      body: "from work account",
      timestamp: Date.parse(workTimestamp),
    },
  ]);
});

test("treats roomHistoryMaxEntries zero as disabled buffering", async () => {
  const stopAfterRecord = createRecordStopError();
  const recorded: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime(
    createRuntimeForInboundTests({
      onRecordInboundSession: async (payload) => {
        recorded.push(payload);
        throw stopAfterRecord;
      },
    }),
  );
  const roomHistory = createMatrixRoomHistoryBuffer(0);
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    groupPolicy: "open",
    roomHistoryMaxEntries: 0,
  } as ResolvedMatrixAccount["config"]);
  const client = createClientForInboundTests();
  const cfg = {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
        groupPolicy: "open",
        roomHistoryMaxEntries: 0,
      },
    },
  } as CoreConfig;

  await handleMatrixInboundEvent({
    cfg,
    account,
    client,
    roomHistory,
    event: createInboundEvent({
      eventId: "$buffered",
      body: "buffer me",
    }),
  });

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account,
      client,
      roomHistory,
      event: createInboundEvent({
        eventId: "$mentioned",
        senderId: "@bu:example.org",
        senderName: "Bu",
        body: "@bot now",
        mentions: {
          userIds: ["@bot:example.org"],
        },
      }),
    }),
    /stop after record/,
  );

  const ctx = recorded[0]?.ctx as Record<string, unknown>;
  assert.equal(ctx.InboundHistory, undefined);
});
