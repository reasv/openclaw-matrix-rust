import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMatrixInboundPresentation,
  detectExplicitMention,
  extractMatrixCustomEmojiUsageFromFormattedBody,
  resolveGroupPolicy,
} from "./inbound.js";
import {
  renderMatrixFormattedBody,
  resolveMatrixBodyForAgent,
  resolveMatrixInboundSenderLabel,
  resolveMatrixReadableBody,
} from "./inbound-format.js";
import type { CoreConfig, MatrixInboundEvent, ResolvedMatrixAccount } from "../types.js";

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
