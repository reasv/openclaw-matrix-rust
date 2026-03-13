import test from "node:test";
import assert from "node:assert/strict";
import { resolveNativeConfig } from "./config.js";
import type { ResolvedMatrixAccount } from "../../types.js";

test("maps account config into native state layout", () => {
  const config = resolveNativeConfig({
    account: {
      accountId: "default",
      enabled: true,
      configured: true,
      homeserver: "https://matrix.example",
      userId: "@bot:example.org",
      authMode: "password",
      deviceName: "Matrix Bot",
      config: {
        password: "secret",
        encryption: true,
        threadReplies: "inbound",
        replyToMode: "first",
        rooms: {
          "!room:example.org": {
            threadReplies: "off",
            requireMention: false,
          },
        },
      },
    } satisfies ResolvedMatrixAccount,
    runtime: {
      state: {
        resolveStateDir: () => "/tmp/openclaw-state",
      },
    } as never,
  });

  assert.equal(config.auth.mode, "password");
  assert.equal(config.stateLayout.rootDir, "/tmp/openclaw-state/plugins/matrix-rust/default");
  assert.deepEqual(config.roomOverrides["!room:example.org"], {
    threadReplies: "off",
    requireMention: false,
  });
});

test("maps groups into native room overrides when rooms are unset", () => {
  const config = resolveNativeConfig({
    account: {
      accountId: "default",
      enabled: true,
      configured: true,
      homeserver: "https://matrix.example",
      userId: "@bot:example.org",
      authMode: "password",
      config: {
        password: "secret",
        groups: {
          "!group:example.org": {
            threadReplies: "always",
            requireMention: false,
          },
        },
      },
    } satisfies ResolvedMatrixAccount,
    runtime: {
      state: {
        resolveStateDir: () => "/tmp/openclaw-state",
      },
    } as never,
  });

  assert.deepEqual(config.roomOverrides["!group:example.org"], {
    threadReplies: "always",
    requireMention: false,
  });
});
