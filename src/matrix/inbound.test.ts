import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMatrixInboundPresentation,
  detectExplicitMention,
  extractMatrixCustomEmojiUsageFromFormattedBody,
  resolveMatrixReplyContext,
  resolveMatrixThreadContext,
  resolveGroupPolicy,
  sendMatrixMedia,
} from "./inbound.js";
import {
  buildMatrixEnrichedBodyText,
  renderMatrixFormattedBody,
  resolveMatrixBodyForAgent,
  resolveMatrixInboundSenderLabel,
  resolveMatrixReadableBody,
} from "./inbound-format.js";
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
    previewTextBlocks: [],
    eventTimestamp: Date.now(),
    previousTimestamp: 123,
    envelopeOptions: {},
    formatInboundEnvelope: (params) => `formatted:${params.senderLabel}:${params.body}`,
  });

  assert.equal(presentation.senderUsername, "bu");
  assert.equal(presentation.senderLabel, "Bu (bu)");
  assert.equal(presentation.baseBodyText, "hello :party_parrot:");
  assert.equal(presentation.bodyForAgent, "Bu (bu): hello :party_parrot:");
  assert.match(presentation.body, /^formatted:Bu \(bu\):hello :party_parrot:/);
  assert.match(
    presentation.body,
    /\[matrix event id: \$event room: !room:example\.org thread: \$thread-root\]/,
  );
});

test("formats reply preview blocks separately from current-message previews", () => {
  assert.equal(
    buildMatrixEnrichedBodyText({
      baseBodyText: "current body",
      replyToId: "$parent",
      replyToSender: "Alice",
      replyToBody: "look at https://x.com/example/status/1",
      replyPreviewTextBlocks: ["[Tweet: Alice (@alice)]\nhello"],
      previewTextBlocks: ["[Link preview: example.org]\ncurrent preview"],
    }),
    [
      "current body",
      "[Replying to Alice id:$parent]",
      "look at https://x.com/example/status/1",
      "[Reply link preview]",
      "[Tweet: Alice (@alice)]",
      "hello",
      "[Link preview: example.org]",
      "current preview",
    ].join("\n"),
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
    account,
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
  assert.deepEqual(replyContext.replyPreviewTextBlocks, ["[Tweet: Alice (@alice)]\nhello from x"]);
  assert.deepEqual(replyContext.replyPreviewMedia, [
    { path: "/tmp/reply-preview.png", contentType: "image/png" },
  ]);
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
