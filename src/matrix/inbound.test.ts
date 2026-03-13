import assert from "node:assert/strict";
import test from "node:test";

import {
  detectExplicitMention,
  extractMatrixCustomEmojiUsageFromFormattedBody,
  resolveGroupPolicy,
} from "./inbound.js";
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
