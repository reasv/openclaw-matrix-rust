import test from "node:test";
import assert from "node:assert/strict";
import { MatrixRustConfigSchema } from "./config-schema.js";

test("accepts per-room threadReplies overrides", () => {
  const result = MatrixRustConfigSchema.parse({
    homeserver: "https://matrix.example",
    userId: "@bot:example.org",
    password: "secret",
    threadReplies: "inbound",
    rooms: {
      "!room:example.org": {
        threadReplies: "off",
      },
    },
  });

  assert.equal(result.threadReplies, "inbound");
  assert.equal(result.rooms?.["!room:example.org"]?.threadReplies, "off");
});

test("accepts media handoff settings", () => {
  const result = MatrixRustConfigSchema.parse({
    homeserver: "https://matrix.example",
    userId: "@bot:example.org",
    password: "secret",
    autoDownloadAttachmentMaxBytes: 1048576,
    autoDownloadAttachmentScope: "all",
    imageHandlingMode: "multimodal-only",
    otherMediaPaths: false,
  });

  assert.equal(result.autoDownloadAttachmentMaxBytes, 1048576);
  assert.equal(result.autoDownloadAttachmentScope, "all");
  assert.equal(result.imageHandlingMode, "multimodal-only");
  assert.equal(result.otherMediaPaths, false);
});

test("accepts user profile hint settings", () => {
  const result = MatrixRustConfigSchema.parse({
    homeserver: "https://matrix.example",
    userId: "@bot:example.org",
    password: "secret",
    userProfiles: {
      enabled: false,
      rootDir: "profiles",
    },
  });

  assert.equal(result.userProfiles?.enabled, false);
  assert.equal(result.userProfiles?.rootDir, "profiles");
});
