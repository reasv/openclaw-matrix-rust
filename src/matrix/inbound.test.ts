import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import {
  clearMatrixFlushedEventDedupes,
  hasMatrixFlushedEvent,
  resolveMatrixFlushedEventDedupeFilePath,
} from "./flushed-event-dedupe.js";
import {
  buildMatrixInboundPresentation,
  buildMatrixPromptImages,
  detectExplicitMention,
  deliverReplyPayload,
  extractMatrixCustomEmojiUsageFromFormattedBody,
  filterMatrixMediaForContext,
  handleMatrixInboundEvent,
  maybeBuildMatrixUploadThumbnail,
  resolveMatrixBatchMediaSelection,
  resolveMatrixInboundRoute,
  resolveMatrixReplyContext,
  resolveMatrixThreadContext,
  resolveGroupPolicy,
  sendMatrixMedia,
} from "./inbound.js";
import {
  buildMatrixAttachmentTextBlocks,
  buildMatrixEnrichedBodyText,
  renderMatrixFormattedBody,
  resolveMatrixBodyForAgent,
  resolveMatrixInboundSenderLabel,
  resolveMatrixReadableBody,
} from "./inbound-format.js";
import { createMatrixRoomHistoryBuffer } from "./history-buffer.js";
import { detectSillyTavernCardFromBuffer } from "./sillytavern-card-detect.js";
import type { CoreConfig, MatrixInboundEvent, ResolvedMatrixAccount } from "../types.js";
import { setMatrixRustRuntime } from "../runtime.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
  "base64",
);
const TINY_CARD_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8DwHx9mGBkKAMLXf4EvceABAAAAUnRFWHRjaGFyYQBleUp6Y0dWaklqb2lZMmhoY21GZlkyRnlaRjkyTWlJc0ltUmhkR0VpT25zaWJtRnRaU0k2SWtobGNtOGdSWGhoYlhCc1pTSjlmUT09p6SKxQAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_ANIMATED_GIF = Buffer.from(
  "R0lGODlhCAAIAPAAAP8AAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACH/C0ltYWdlTWFnaWNrDmdhbW1hPTAuNDU0NTQ1ACwAAAAACAAIAAACB4SPqcvtXQAAIfkEAAoAAAAh/wtJbWFnZU1hZ2ljaw5nYW1tYT0wLjQ1NDU0NQAsAAAAAAgACACAAIAA////AgeEj6nL7V0AADs=",
  "base64",
);

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

async function createLargeNoisePng(params: { width: number; height: number }) {
  const raw = crypto.randomBytes(params.width * params.height * 3);
  return await sharp(raw, {
    raw: {
      width: params.width,
      height: params.height,
      channels: 3,
    },
  }).png().toBuffer();
}

function createRecordStopError() {
  return new Error("stop after record");
}

function createRuntimeForInboundTests(params: {
  onRecordInboundSession: (payload: Record<string, unknown>) => Promise<unknown>;
  stateDir?: string;
  hasControlCommand?: (body: string, cfg: CoreConfig) => boolean;
}) {
  return {
    state: {
      resolveStateDir: () => params.stateDir ?? "/tmp/openclaw-matrix-rust-state",
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
        hasControlCommand: params.hasControlCommand ?? (() => false),
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
      media: {
        saveMediaBuffer: async (
          _buffer: Buffer,
          contentType?: string,
          _kind?: string,
          _maxBytes?: number,
          filename?: string,
        ) => ({
          path: path.join(os.tmpdir(), filename ?? "matrix-test-attachment"),
          contentType,
        }),
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
    downloadMedia: ({ eventId }: { eventId: string }) => ({
      roomId: "!room:example.org",
      eventId,
      kind: "image",
      filename: "matrix-test.png",
      contentType: "image/png",
      dataBase64: Buffer.from("matrix-test-image").toString("base64"),
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

function buildSillyTavernCardPng(name: string): Buffer {
  const card = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
      description: "",
      personality: "",
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: [],
      creator: "",
      character_version: "",
      extensions: {},
    },
  };
  const payload = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  return insertTextChunk(TINY_PNG, "chara", payload);
}

function insertTextChunk(png: Buffer, keyword: string, text: string): Buffer {
  const iendOffset = findPngChunkOffset(png, "IEND");
  const chunk = encodePngChunk("tEXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]));
  return Buffer.concat([png.subarray(0, iendOffset), chunk, png.subarray(iendOffset)]);
}

function findPngChunkOffset(png: Buffer, chunkType: string): number {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    if (type === chunkType) {
      return offset;
    }
    offset += 12 + length;
  }
  throw new Error(`PNG chunk ${chunkType} not found`);
}

function encodePngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "latin1");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("resolveMatrixInboundRoute builds a room-scoped parent session for parent-bound DMs", () => {
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
  } as ResolvedMatrixAccount["config"]);
  const event = createInboundEvent({
    roomId: "!dm:example.org",
    chatType: "direct",
  });

  const route = resolveMatrixInboundRoute({
    cfg: {} as CoreConfig,
    account,
    event,
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:matrix:direct:@alice:example.org",
            mainSessionKey: "agent:main:main",
            matchedBy: "binding.peer.parent",
          }),
          buildAgentSessionKey: ({ peer }: { peer: { id: string } }) =>
            `agent:main:matrix:channel:${peer.id}`,
        },
      },
    } as any,
  });

  assert.equal(route.isDirectMessage, true);
  assert.equal(route.parentSessionKey, "agent:main:matrix:channel:!dm:example.org");
  assert.equal(route.sessionKey, "agent:main:matrix:channel:!dm:example.org");
  assert.equal(route.lastRoutePolicy, "session");
});

test("resolveMatrixInboundRoute appends thread roots without changing the parent session", () => {
  const route = resolveMatrixInboundRoute({
    cfg: {} as CoreConfig,
    account: createResolvedAccount(),
    event: createInboundEvent({
      threadRootId: "$thread-root",
    }),
    runtime: createRuntimeForInboundTests({
      onRecordInboundSession: async () => undefined,
    }),
  });

  assert.equal(route.parentSessionKey, "agent:main:matrix:channel:!room:example.org");
  assert.equal(
    route.sessionKey,
    "agent:main:matrix:channel:!room:example.org:thread:$thread-root",
  );
});

test("resolveMatrixInboundRoute treats direct-matched configured rooms as channel sessions", () => {
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    rooms: {
      "!dm:example.org": {
        autoReply: true,
      },
    },
  } as ResolvedMatrixAccount["config"]);
  const event = createInboundEvent({
    roomId: "!dm:example.org",
    chatType: "direct",
  });
  const resolveCalls: Array<Record<string, any>> = [];

  const route = resolveMatrixInboundRoute({
    cfg: {} as CoreConfig,
    account,
    event,
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: (payload: Record<string, unknown>) => {
            resolveCalls.push(payload as Record<string, any>);
            return {
              agentId: "main",
              accountId: "default",
              sessionKey: "agent:main:matrix:channel:!dm:example.org",
              mainSessionKey: "agent:main:main",
            };
          },
          buildAgentSessionKey: () => "agent:main:matrix:channel:!dm:example.org",
        },
      },
    } as any,
  });

  assert.equal(route.isDirectMessage, false);
  assert.equal(resolveCalls[0]?.peer?.kind, "channel");
  assert.equal(resolveCalls[0]?.peer?.id, "!dm:example.org");
});

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

test("resolveMatrixBatchMediaSelection falls back to the last earlier media-bearing event", () => {
  const earlier = {
    media: [{ path: "/tmp/earlier.png", contentType: "image/png" }],
    promptImages: [{ type: "image" as const, data: "earlier", mimeType: "image/png" }],
  };
  const later = {
    media: [{ path: "/tmp/later.png", contentType: "image/png" }],
    promptImages: [{ type: "image" as const, data: "later", mimeType: "image/png" }],
  };

  assert.deepEqual(
    resolveMatrixBatchMediaSelection({
      subject: {
        media: [],
        promptImages: [],
      },
      previous: [earlier, later],
    }),
    later,
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
    "Bu (bu): hello :party_parrot:",
  );
  assert.match(presentation.body, /^formatted:Bu \(bu\):hello :party_parrot:/);
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
      '[Attachment 1] filename="photo.jpg" type="image/jpeg" saved-to="./msg-attach/" saved-as="ABCDE12345.jpg" local-path-note="combine saved-to + saved-as"',
    ],
  );
});

test("includes SillyTavern card detection in attachment manifest text when present", () => {
  assert.deepEqual(
    buildMatrixAttachmentTextBlocks({
      attachments: [
        {
          index: 0,
          filename: "hero.png",
          contentType: "image/png",
          kind: "image",
          savedTo: "./msg-attach/ABCDE12345.png",
          detected: "sillytavern-character-card",
          cardName: "Hero Example",
        },
      ],
    }),
    [
      "[Attachments: 1]",
      '[Attachment 1] filename="hero.png" type="image/png" saved-to="./msg-attach/" saved-as="ABCDE12345.png" local-path-note="combine saved-to + saved-as" detected="sillytavern-character-card" card_name="Hero Example"',
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
    /^\[Reply attachment 1\] filename="reply-photo\.png" type="image\/png" saved-to="\.\/msg-attach\/" saved-as="[A-Z2-7]{10}\.png" local-path-note="combine saved-to \+ saved-as"$/,
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
    /saved-as="([^"]+)"/,
  )?.[1];
  assert.ok(replySavedName);
  const savedPath = path.join(workspaceDir, "msg-attach", replySavedName);
  assert.equal(await fs.readFile(savedPath, "utf8"), "reply-image");
});

test("marks reply attachment manifests when the reply image is a SillyTavern card", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-reply-card-"));
  setMatrixRustRuntime(
    createRuntimeForInboundTests({
      onRecordInboundSession: async () => undefined,
    }),
  );
  const cardPng = buildSillyTavernCardPng("Hero Example");
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
          groupPolicy: "open",
          autoDownloadAttachmentMaxBytes: -1,
        },
      },
    } as CoreConfig,
    account: createResolvedAccount({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "secret",
      groupPolicy: "open",
      autoDownloadAttachmentMaxBytes: -1,
    } as ResolvedMatrixAccount["config"]),
    agentId: "main",
    isRoom: true,
    client: {
      ...createClientForInboundTests(),
      memberInfo: () => ({
        displayName: "Alice",
      }),
      downloadMedia: () => ({
        roomId: "!room:example.org",
        eventId: "$parent-card",
        kind: "image",
        filename: "hero.png",
        contentType: "image/png",
        dataBase64: cardPng.toString("base64"),
      }),
    } as any,
    roomId: "!room:example.org",
    replyToId: "$parent-card",
    replySummary: {
      eventId: "$parent-card",
      sender: "@alice:example.org",
      body: "see card",
      timestamp: new Date().toISOString(),
    },
    persistPreviewMedia: async ({ media }) =>
      media.map((item, index) => ({
        path: `/tmp/reply-card-${index}.png`,
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
    /^\[Reply attachment 1\] filename="hero\.png" type="image\/png" saved-to="\.\/msg-attach\/" saved-as="[A-Z2-7]{10}\.png" local-path-note="combine saved-to \+ saved-as" detected="sillytavern-character-card" card_name="Hero Example"$/,
  );
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

test("maybeBuildMatrixUploadThumbnail skips small images and thumbnails large images to 800px max edge", async () => {
  const smallThumbnail = await maybeBuildMatrixUploadThumbnail({
    buffer: TINY_PNG,
    contentType: "image/png",
    fileName: "tiny.png",
  });
  assert.equal(smallThumbnail, undefined);

  const largePng = await createLargeNoisePng({ width: 1600, height: 1200 });
  assert.ok(largePng.length > 800 * 1024);
  const thumbnail = await maybeBuildMatrixUploadThumbnail({
    buffer: largePng,
    contentType: "image/png",
    fileName: "large.png",
  });

  assert.ok(thumbnail);
  assert.equal(thumbnail?.contentType, "image/webp");
  assert.ok(thumbnail!.sizeBytes > 0);
  const metadata = await sharp(Buffer.from(thumbnail!.dataBase64, "base64"), { animated: true }).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, thumbnail!.width);
  assert.equal(metadata.pageHeight ?? metadata.height, thumbnail!.height);
  assert.ok(thumbnail!.width <= 800);
  assert.ok(thumbnail!.height <= 800);
});

test("maybeBuildMatrixUploadThumbnail renders animated webp thumbnails for animated gifs", async () => {
  const thumbnail = await maybeBuildMatrixUploadThumbnail({
    buffer: TINY_ANIMATED_GIF,
    contentType: "image/gif",
    fileName: "tiny.gif",
    minSourceBytes: 1,
  });

  assert.ok(thumbnail);
  assert.equal(thumbnail?.contentType, "image/webp");
  const metadata = await sharp(Buffer.from(thumbnail!.dataBase64, "base64"), { animated: true }).metadata();
  assert.equal(metadata.format, "webp");
  assert.ok((metadata.pages ?? 1) > 1);
});

test("sendMatrixMedia forwards mediaLocalRoots for local workspace files", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-send-local-"));
  const mediaPath = path.join(workspaceDir, "render.png");
  await fs.writeFile(mediaPath, TINY_PNG);
  const fetchRemoteMediaCalls: unknown[] = [];
  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  const sendMessageCalls: Array<Record<string, unknown>> = [];

  setMatrixRustRuntime({
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
      sendMessage: (request: Record<string, unknown>) => {
        sendMessageCalls.push(request);
        return {
          roomId: "!room:example.org",
          messageId: "$caption",
        };
      },
    } as any,
    to: "!room:example.org",
    mediaUrl: mediaPath,
    mediaLocalRoots: [workspaceDir],
    text: "caption",
  });

  assert.deepEqual(result, {
    channel: "matrix",
    to: "!room:example.org",
    messageId: "$media",
  });
  assert.deepEqual(fetchRemoteMediaCalls, []);
  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "render.png",
      contentType: "image/png",
      dataBase64: TINY_PNG.toString("base64"),
      caption: undefined,
      replyToId: undefined,
      threadId: undefined,
    },
  ]);
  assert.deepEqual(sendMessageCalls, [
    {
      roomId: "!room:example.org",
      text: "caption",
      threadId: undefined,
    },
  ]);
});

test("sendMatrixMedia forwards workspace-aware mediaAccess for relative media paths", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-send-workspace-"));
  await fs.mkdir(path.join(workspaceDir, "cards", "sillytavern"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "cards", "sillytavern", "land-dolphin.png"), TINY_PNG);
  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  const sendMessageCalls: Array<Record<string, unknown>> = [];
  const readFile = async (_filePath: string) => TINY_PNG;

  setMatrixRustRuntime({
    channel: {
      media: {
        fetchRemoteMedia: async () => {
          throw new Error("unexpected fetchRemoteMedia");
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
      sendMessage: (request: Record<string, unknown>) => {
        sendMessageCalls.push(request);
        return {
          roomId: "!room:example.org",
          messageId: "$caption",
        };
      },
    } as any,
    to: "!room:example.org",
    mediaUrl: "cards/sillytavern/land-dolphin.png",
    mediaAccess: {
      localRoots: [workspaceDir],
      readFile,
      workspaceDir,
    },
    text: "caption",
  });

  assert.deepEqual(result, {
    channel: "matrix",
    to: "!room:example.org",
    messageId: "$media",
  });
  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "land-dolphin.png",
      contentType: "image/png",
      dataBase64: TINY_PNG.toString("base64"),
      caption: undefined,
      replyToId: undefined,
      threadId: undefined,
    },
  ]);
  assert.deepEqual(sendMessageCalls, [
    {
      roomId: "!room:example.org",
      text: "caption",
      threadId: undefined,
    },
  ]);
});

test("sendMatrixMedia includes thumbnails for large image attachments", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-send-thumb-"));
  await fs.mkdir(path.join(workspaceDir, "images"), { recursive: true });
  const largePng = await createLargeNoisePng({ width: 1600, height: 1200 });
  assert.ok(largePng.length > 800 * 1024);
  const mediaPath = path.join(workspaceDir, "images", "large.png");
  await fs.writeFile(mediaPath, largePng);
  const uploadMediaCalls: Array<Record<string, unknown>> = [];

  setMatrixRustRuntime({
    channel: {
      media: {
        fetchRemoteMedia: async () => {
          throw new Error("unexpected fetchRemoteMedia");
        },
      },
    },
  } as any);

  await sendMatrixMedia({
    account: createResolvedAccount(),
    client: {
      uploadMedia: (request: Record<string, unknown>) => {
        uploadMediaCalls.push(request);
        return {
          roomId: "!room:example.org",
          messageId: "$thumb",
          filename: String(request.filename),
          contentType: String(request.contentType),
        };
      },
      sendMessage: () => {
        throw new Error("unexpected sendMessage");
      },
    } as any,
    to: "!room:example.org",
    mediaUrl: mediaPath,
    mediaLocalRoots: [workspaceDir],
  });

  assert.equal(uploadMediaCalls.length, 1);
  const thumbnail = uploadMediaCalls[0]?.thumbnail as
    | {
        dataBase64: string;
        contentType: string;
        width: number;
        height: number;
        sizeBytes: number;
      }
    | undefined;
  assert.ok(thumbnail);
  assert.equal(thumbnail?.contentType, "image/webp");
  assert.ok(thumbnail!.width <= 800);
  assert.ok(thumbnail!.height <= 800);
  const metadata = await sharp(Buffer.from(thumbnail!.dataBase64, "base64"), { animated: true }).metadata();
  assert.equal(metadata.format, "webp");
});

test("sendMatrixMedia preserves raw SillyTavern card PNG metadata", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-send-card-"));
  await fs.mkdir(path.join(workspaceDir, "cards", "sillytavern"), { recursive: true });
  const mediaPath = path.join(workspaceDir, "cards", "sillytavern", "hero.png");
  await fs.writeFile(mediaPath, TINY_CARD_PNG);

  const loadWebMediaCalls: Array<{ mediaUrl: string; options: Record<string, unknown> }> = [];
  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  const sendMessageCalls: Array<Record<string, unknown>> = [];

  setMatrixRustRuntime({
    media: {
      loadWebMedia: async (mediaUrl: string, options?: Record<string, unknown>) => {
        loadWebMediaCalls.push({ mediaUrl, options: options ?? {} });
        return {
          buffer: Buffer.from("optimized-image"),
          contentType: "image/jpeg",
          fileName: "hero.jpg",
        };
      },
    },
    channel: {
      media: {
        fetchRemoteMedia: async () => {
          throw new Error("unexpected fetchRemoteMedia");
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
          messageId: "$card",
          filename: String(request.filename),
          contentType: String(request.contentType),
        };
      },
      sendMessage: (request: Record<string, unknown>) => {
        sendMessageCalls.push(request);
        return {
          roomId: "!room:example.org",
          messageId: "$caption",
        };
      },
    } as any,
    to: "!room:example.org",
    mediaUrl: "cards/sillytavern/hero.png",
    mediaAccess: {
      localRoots: [workspaceDir],
      workspaceDir,
    },
    text: "caption",
  });

  assert.deepEqual(result, {
    channel: "matrix",
    to: "!room:example.org",
    messageId: "$card",
  });
  assert.deepEqual(loadWebMediaCalls, []);
  assert.deepEqual(uploadMediaCalls.length, 1);
  assert.equal(uploadMediaCalls[0]?.filename, "hero.png");
  assert.equal(uploadMediaCalls[0]?.contentType, "image/png");
  const uploadedBuffer = Buffer.from(String(uploadMediaCalls[0]?.dataBase64), "base64");
  assert.deepEqual(detectSillyTavernCardFromBuffer(uploadedBuffer), {
    detected: "sillytavern-character-card",
    cardName: "Hero Example",
  });
  assert.deepEqual(sendMessageCalls, [
    {
      roomId: "!room:example.org",
      text: "caption",
      threadId: undefined,
    },
  ]);
});

test("deliverReplyPayload resolves relative media paths against the agent workspace", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-reply-workspace-"));
  await fs.mkdir(path.join(workspaceDir, "cards", "sillytavern"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "cards", "sillytavern", "land-dolphin.png"), TINY_PNG);

  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  const sendMessageCalls: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime({
    state: {
      resolveStateDir: () => "/tmp/openclaw-matrix-rust-state",
    },
    channel: {
      media: {
        fetchRemoteMedia: async () => {
          throw new Error("unexpected fetchRemoteMedia");
        },
      },
    },
  } as any);

  await deliverReplyPayload({
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as CoreConfig,
    agentId: "main",
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
      sendMessage: (request: Record<string, unknown>) => {
        sendMessageCalls.push(request);
        return {
          roomId: "!room:example.org",
          messageId: "$caption",
        };
      },
    } as any,
    inboundEvent: createInboundEvent(),
    payload: {
      text: "caption",
      mediaUrl: "cards/sillytavern/land-dolphin.png",
    },
  });

  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "land-dolphin.png",
      contentType: "image/png",
      dataBase64: TINY_PNG.toString("base64"),
      caption: undefined,
      replyToId: undefined,
      threadId: undefined,
    },
  ]);
  assert.deepEqual(sendMessageCalls, [
    {
      roomId: "!room:example.org",
      text: "caption",
      threadId: undefined,
    },
  ]);
});

test("sendMatrixMedia keeps remote URL loading on the remote fetch path", async () => {
  const loadWebMediaCalls: unknown[] = [];
  const fetchRemoteMediaCalls: Array<Record<string, unknown>> = [];
  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  const sendMessageCalls: Array<Record<string, unknown>> = [];

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
      sendMessage: (request: Record<string, unknown>) => {
        sendMessageCalls.push(request);
        return {
          roomId: "!room:example.org",
          messageId: "$caption",
        };
      },
    } as any,
    to: "!room:example.org",
    mediaUrl: "https://example.com/report.pdf",
    mediaLocalRoots: ["/tmp/workspace-agent"],
    text: "Quarterly report",
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
  assert.deepEqual(sendMessageCalls, [
    {
      roomId: "!room:example.org",
      text: "Quarterly report",
      threadId: undefined,
    },
  ]);
});

test("buffers unmentioned room messages and flushes them on the next mention", async () => {
  const stopAfterRecord = createRecordStopError();
  const firstTimestamp = "2026-03-14T12:00:00.000Z";
  const recorded: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-rust-inbound-no-dedupe-"));
  clearMatrixFlushedEventDedupes();
  setMatrixRustRuntime(
    createRuntimeForInboundTests({
      onRecordInboundSession: async (payload) => {
        recorded.push(payload);
        throw stopAfterRecord;
      },
      stateDir,
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
    log: {
      debug: (message) => {
        logs.push(message);
      },
    },
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
      log: {
        debug: (message) => {
          logs.push(message);
        },
      },
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
    "Bu (bu): @bot what do you think?",
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
    eventId: "$event-1",
    sender: "Alice (alice)",
    body: [
      "just chatting",
      "[Attachments: 1]",
      '[Attachment 1] filename="buffered.png" type="image/png"',
    ].join("\n"),
    timestamp: Date.parse(firstTimestamp),
  });
  assert.equal(retainedHistory[1]?.eventId, "$event-2");
  assert.equal(retainedHistory[1]?.sender, "Bu (bu)");
  assert.equal(retainedHistory[1]?.body, "@bot what do you think?");
  assert.equal(typeof retainedHistory[1]?.timestamp, "number");
  assert.ok(
    logs.some((message) =>
      /\[matrix:default\] room buffer add scope=default:!room:example\.org event=\$event-1 count=1 source=subject/.test(
        message,
      ),
    ),
  );
  assert.ok(
    logs.some((message) =>
      /\[matrix:default\] room buffer hold scope=default:!room:example\.org event=\$event-1 count=1 reason=no-trigger/.test(
        message,
      ),
    ),
  );
  assert.ok(
    logs.some((message) =>
      /\[matrix:default\] room buffer replay scope=default:!room:example\.org event=\$event-2 count=1/.test(
        message,
      ),
    ),
  );
  assert.equal(
    await hasMatrixFlushedEvent({
      runtime: { state: { resolveStateDir: () => stateDir } } as any,
      accountId: account.accountId,
      event: { roomId: "!room:example.org", eventId: "$event-1" },
    }),
    false,
  );
  await assert.rejects(
    fs.readFile(
      resolveMatrixFlushedEventDedupeFilePath({
        runtime: { state: { resolveStateDir: () => stateDir } } as any,
        accountId: account.accountId,
      }),
      "utf-8",
    ),
    { code: "ENOENT" },
  );
});

test("clears buffered room history after inbound session recording succeeds", async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-rust-inbound-dedupe-"));
  clearMatrixFlushedEventDedupes();
  const runtime = createRuntimeForInboundTests({
    onRecordInboundSession: async (payload) => {
      recorded.push(payload);
    },
    stateDir,
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
    log: {
      debug: (message) => {
        logs.push(message);
      },
    },
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
      log: {
        debug: (message) => {
          logs.push(message);
        },
      },
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
  assert.equal(
    await hasMatrixFlushedEvent({
      runtime: { state: { resolveStateDir: () => stateDir } } as any,
      accountId: account.accountId,
      event: { roomId: "!room:example.org", eventId: "$event-1" },
    }),
    true,
  );
  assert.equal(
    await hasMatrixFlushedEvent({
      runtime: { state: { resolveStateDir: () => stateDir } } as any,
      accountId: account.accountId,
      event: { roomId: "!room:example.org", eventId: "$event-2" },
    }),
    true,
  );
  assert.ok(
    logs.some((message) =>
      /\[matrix:default\] room buffer clear scope=default:!room:example\.org event=\$event-2 count=2/.test(
        message,
      ),
    ),
  );
});

test("skipStartupGrace allows startup backfill events to be replayed once", async () => {
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
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    dm: {
      policy: "open",
    },
  } as ResolvedMatrixAccount["config"]);
  const client = {
    ...createClientForInboundTests(),
    diagnostics: () => ({
      accountId: "default",
      userId: "@bot:example.org",
      deviceId: "DEVICE",
      verificationState: "verified",
      keyBackupState: "enabled",
      syncState: "ready",
      lastSuccessfulSyncAt: null,
      lastSuccessfulDecryptionAt: null,
      startedAt: "2026-03-15T12:00:00.000Z",
    }),
  } as any;
  const event = createInboundEvent({
    roomId: "!dm:example.org",
    chatType: "direct",
    timestamp: "2026-03-15T11:59:00.000Z",
  });
  const cfg = {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
        dm: {
          policy: "open",
        },
      },
    },
  } as CoreConfig;

  await handleMatrixInboundEvent({
    cfg,
    account,
    client,
    roomHistory,
    event,
  });
  assert.equal(recorded.length, 0);

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account,
      client,
      roomHistory,
      event,
      skipStartupGrace: true,
    }),
    stopAfterRecord,
  );
  assert.equal(recorded.length, 1);
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
    /^buffered image\n\[Attachments: 1\]\n\[Attachment 1\] filename="buffered\.png" type="image\/png" saved-to="\.\/msg-attach\/" saved-as="([A-Z2-7]{10}\.png)" local-path-note="combine saved-to \+ saved-as"$/,
  );
  const savedName = (inboundHistory[0]?.body ?? "").match(
    /saved-as="([^"]+)"/,
  )?.[1];
  assert.ok(savedName);
  const savedPath = path.join(workspaceDir, "msg-attach", savedName);
  assert.equal(await fs.readFile(savedPath, "utf8"), "buffered-image");
});

test("auto-downloads direct-message attachments into the agent workspace when scope=all", async () => {
  const stopAfterRecord = createRecordStopError();
  const recorded: Array<Record<string, unknown>> = [];
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-dm-attach-"));
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
        autoDownloadAttachmentMaxBytes: -1,
        autoDownloadAttachmentScope: "all",
        dm: {
          policy: "open",
        },
      },
    },
  } as CoreConfig;
  const account = createResolvedAccount(cfg.channels?.matrix as ResolvedMatrixAccount["config"]);
  const client = {
    ...createClientForInboundTests(),
    downloadMedia: ({ eventId }: { eventId: string }) => {
      assert.equal(eventId, "$dm-image");
      return {
        roomId: "!dm:example.org",
        eventId,
        kind: "image",
        filename: "dm-photo.png",
        contentType: "image/png",
        dataBase64: Buffer.from("dm-image").toString("base64"),
      };
    },
  } as any;

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account,
      client,
      roomHistory,
      event: createInboundEvent({
        roomId: "!dm:example.org",
        eventId: "$dm-image",
        chatType: "direct",
        body: "look at this",
        media: [
          {
            index: 0,
            kind: "image",
            filename: "dm-photo.png",
            contentType: "image/png",
          },
        ],
      }),
    }),
    /stop after record/,
  );

  const ctx = recorded[0]?.ctx as Record<string, unknown>;
  assert.match(
    String(ctx.BodyForAgent ?? ""),
    /^look at this\n\[Attachments: 1\]\n\[Attachment 1\] filename="dm-photo\.png" type="image\/png" saved-to="\.\/msg-attach\/" saved-as="([A-Z2-7]{10}\.png)" local-path-note="combine saved-to \+ saved-as"$/,
  );
  const savedName = String(ctx.BodyForAgent ?? "").match(
    /saved-as="([^"]+)"/,
  )?.[1];
  assert.ok(savedName);
  const savedPath = path.join(workspaceDir, "msg-attach", savedName);
  assert.equal(await fs.readFile(savedPath, "utf8"), "dm-image");
  assert.equal(ctx.InboundHistory, undefined);
});


test("batched room context falls back to the last earlier media-bearing message when the subject has none", async () => {
  const stopAfterRecord = createRecordStopError();
  const recorded: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
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
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
        groupPolicy: "open",
      },
    },
  } as CoreConfig;
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    groupPolicy: "open",
  } as ResolvedMatrixAccount["config"]);

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account,
      client: {
        ...createClientForInboundTests(),
        downloadMedia: ({ eventId }: { eventId: string }) => {
          assert.equal(eventId, "$earlier-image");
          return {
            roomId: "!room:example.org",
            eventId,
            kind: "image",
            filename: "earlier.png",
            contentType: "image/png",
            dataBase64: Buffer.from("earlier-image").toString("base64"),
          };
        },
      } as any,
      roomHistory,
      log: {
        debug: (message) => {
          logs.push(message);
        },
      },
      event: createInboundEvent({
        eventId: "$subject-mention",
        senderId: "@alice:example.org",
        senderName: "Alice",
        body: "@bot what is this?",
        mentions: {
          userIds: ["@bot:example.org"],
        },
      }),
      batchPreviousEvents: [
        createInboundEvent({
          eventId: "$earlier-image",
          senderId: "@alice:example.org",
          senderName: "Alice",
          body: "earlier.png",
          msgtype: "m.image",
          media: [
            {
              index: 0,
              kind: "image",
              filename: "earlier.png",
              contentType: "image/png",
            },
          ],
        }),
      ],
    }),
    stopAfterRecord,
  );

  const ctx = recorded[0]?.ctx as Record<string, unknown>;
  const inboundHistory = ctx.InboundHistory as Array<{
    sender: string;
    body: string;
    timestamp?: number;
  }>;
  assert.equal(ctx.MessageSid, "$subject-mention");
  assert.equal(ctx.MediaPath, "/tmp/earlier.png");
  assert.deepEqual(ctx.MediaPaths, ["/tmp/earlier.png"]);
  assert.equal(ctx.WasMentioned, true);
  assert.equal(inboundHistory.length, 1);
  assert.equal(inboundHistory[0]?.sender, "Alice (alice)");
  assert.equal(
    inboundHistory[0]?.body,
    [
      "earlier.png",
      "[Attachments: 1]",
      '[Attachment 1] filename="earlier.png" type="image/png"',
    ].join("\n"),
  );
  assert.equal(typeof inboundHistory[0]?.timestamp, "number");
  assert.ok(
    logs.some((message) =>
      /\[matrix:default\] inbound media fallback subject=\$subject-mention source=\$earlier-image media=1 prompt_images=1/.test(
        message,
      ),
    ),
  );
});

test("room buffer does not carry over into a /new reset turn", async () => {
  const stopAfterRecord = createRecordStopError();
  const recorded: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime(
    createRuntimeForInboundTests({
      onRecordInboundSession: async (payload) => {
        recorded.push(payload);
        throw stopAfterRecord;
      },
      hasControlCommand: (body) => body.toLowerCase().includes("/new"),
    }),
  );
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const cfg = {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
        groupPolicy: "open",
        rooms: {
          "!room:example.org": {
            users: ["@alice:example.org"],
          },
        },
      },
    },
  } as CoreConfig;
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    groupPolicy: "open",
    rooms: {
      "!room:example.org": {
        users: ["@alice:example.org"],
      },
    },
  } as ResolvedMatrixAccount["config"]);
  const client = createClientForInboundTests();

  await handleMatrixInboundEvent({
    cfg,
    account,
    client,
    roomHistory,
    event: createInboundEvent({
      eventId: "$buffered",
      body: "buffer me",
      timestamp: "2026-03-14T12:00:00.000Z",
    }),
  });

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account,
      client,
      roomHistory,
      event: createInboundEvent({
        eventId: "$reset",
        senderId: "@alice:example.org",
        senderName: "Alice",
        body: "@bot /new",
        mentions: {
          userIds: ["@bot:example.org"],
        },
        timestamp: "2026-03-14T12:01:00.000Z",
      }),
    }),
    stopAfterRecord,
  );

  const ctx = recorded[0]?.ctx as Record<string, unknown>;
  assert.equal(ctx.MessageSid, "$reset");
  assert.equal(ctx.InboundHistory, undefined);
});

test("batched room context can trigger from an earlier mention while preserving the final media subject", async () => {
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
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const cfg = {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
        groupPolicy: "open",
        rooms: {
          "!room:example.org": {
            users: ["@alice:example.org"],
          },
        },
      },
    },
  } as CoreConfig;
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    groupPolicy: "open",
    rooms: {
      "!room:example.org": {
        users: ["@alice:example.org"],
      },
    },
  } as ResolvedMatrixAccount["config"]);

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account,
      client: {
        ...createClientForInboundTests(),
        downloadMedia: ({ eventId }: { eventId: string }) => {
          assert.equal(eventId, "$subject-image");
          return {
            roomId: "!room:example.org",
            eventId,
            kind: "image",
            filename: "subject.png",
            contentType: "image/png",
            dataBase64: Buffer.from("subject-image").toString("base64"),
          };
        },
      } as any,
      roomHistory,
      event: createInboundEvent({
        eventId: "$subject-image",
        senderId: "@alice:example.org",
        senderName: "Alice",
        body: "subject.png",
        msgtype: "m.image",
        media: [
          {
            index: 0,
            kind: "image",
            filename: "subject.png",
            contentType: "image/png",
          },
        ],
      }),
      batchPreviousEvents: [
        createInboundEvent({
          eventId: "$earlier-mention",
          senderId: "@alice:example.org",
          senderName: "Alice",
          body: "@bot check this",
          mentions: {
            userIds: ["@bot:example.org"],
          },
        }),
      ],
    }),
    stopAfterRecord,
  );

  const ctx = recorded[0]?.ctx as Record<string, unknown>;
  const inboundHistory = ctx.InboundHistory as Array<{
    sender: string;
    body: string;
  }>;
  assert.equal(ctx.MessageSid, "$subject-image");
  assert.equal(ctx.WasMentioned, false);
  assert.equal(ctx.MediaPath, "/tmp/subject.png");
  assert.deepEqual(ctx.MediaPaths, ["/tmp/subject.png"]);
  assert.equal(inboundHistory.length, 1);
  assert.equal(inboundHistory[0]?.sender, "Alice (alice)");
  assert.equal(inboundHistory[0]?.body, "@bot check this");
});

test("reset turns do not inherit earlier batched history or media fallback", async () => {
  const stopAfterRecord = createRecordStopError();
  const recorded: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime(
    createRuntimeForInboundTests({
      onRecordInboundSession: async (payload) => {
        recorded.push(payload);
        throw stopAfterRecord;
      },
      hasControlCommand: (body) => body.toLowerCase().includes("/new"),
    }),
  );
  const roomHistory = createMatrixRoomHistoryBuffer(5);
  const cfg = {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "secret",
        groupPolicy: "open",
        rooms: {
          "!room:example.org": {
            autoReply: true,
            users: ["@alice:example.org"],
          },
        },
      },
    },
  } as CoreConfig;
  const account = createResolvedAccount({
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    password: "secret",
    groupPolicy: "open",
    rooms: {
      "!room:example.org": {
        autoReply: true,
        users: ["@alice:example.org"],
      },
    },
  } as ResolvedMatrixAccount["config"]);
  const client = {
    ...createClientForInboundTests(),
    mediaPathForInbound: async (params: { eventId?: string }) => {
      if (params.eventId === "$earlier-image") {
        return {
          path: "/tmp/earlier.png",
          contentType: "image/png",
          kind: "image",
          promptImage: {
            type: "image" as const,
            data: Buffer.from("earlier-image").toString("base64"),
            mimeType: "image/png",
          },
        };
      }
      return undefined;
    },
  } as any;

  await assert.rejects(
    handleMatrixInboundEvent({
      cfg,
      account,
      client,
      roomHistory,
      event: createInboundEvent({
        eventId: "$reset-subject",
        senderId: "@alice:example.org",
        senderName: "Alice",
        body: "@bot /new take notes",
        mentions: {
          userIds: ["@bot:example.org"],
        },
      }),
      batchPreviousEvents: [
        createInboundEvent({
          eventId: "$earlier-image",
          senderId: "@alice:example.org",
          senderName: "Alice",
          body: "earlier.png",
          msgtype: "m.image",
          media: [
            {
              index: 0,
              kind: "image",
              filename: "earlier.png",
              contentType: "image/png",
            },
          ],
        }),
      ],
    }),
    stopAfterRecord,
  );

  const ctx = recorded[0]?.ctx as Record<string, unknown>;
  assert.equal(ctx.MessageSid, "$reset-subject");
  assert.equal(ctx.InboundHistory, undefined);
  assert.equal(ctx.MediaPath, undefined);
  assert.equal(ctx.MediaPaths, undefined);
});

test("auto-downloads SillyTavern card images and advertises card detection in history", async () => {
  const stopAfterRecord = createRecordStopError();
  const recorded: Array<Record<string, unknown>> = [];
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-buffered-card-"));
  const bufferedTimestamp = "2026-03-14T12:00:00.000Z";
  const cardPng = buildSillyTavernCardPng("Hero Example");
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
      assert.equal(eventId, "$buffered-card");
      return {
        roomId: "!room:example.org",
        eventId,
        kind: "image",
        filename: "hero.png",
        contentType: "image/png",
        dataBase64: cardPng.toString("base64"),
      };
    },
  } as any;

  await handleMatrixInboundEvent({
    cfg,
    account,
    client,
    roomHistory,
    event: createInboundEvent({
      eventId: "$buffered-card",
      body: "buffered card",
      timestamp: bufferedTimestamp,
      media: [
        {
          index: 0,
          kind: "image",
          filename: "hero.png",
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
        eventId: "$mentioned-card",
        senderId: "@bu:example.org",
        senderName: "Bu",
        body: "@bot inspect card",
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
    /^buffered card\n\[Attachments: 1\]\n\[Attachment 1\] filename="hero\.png" type="image\/png" saved-to="\.\/msg-attach\/" saved-as="([A-Z2-7]{10}\.png)" local-path-note="combine saved-to \+ saved-as" detected="sillytavern-character-card" card_name="Hero Example"$/,
  );
  const savedName = (inboundHistory[0]?.body ?? "").match(
    /saved-as="([^"]+)"/,
  )?.[1];
  assert.ok(savedName);
  const savedPath = path.join(workspaceDir, "msg-attach", savedName);
  assert.deepEqual(await fs.readFile(savedPath), cardPng);
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
