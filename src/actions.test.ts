import assert from "node:assert/strict";
import test from "node:test";
import { matrixRustActions } from "./actions.js";
import type { CoreConfig } from "./types.js";

const baseConfig: CoreConfig = {
  channels: {
    matrix: {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "secret",
    },
  },
};

test("lists the full action surface when all families are enabled", () => {
  const actions = matrixRustActions.listActions({
    cfg: baseConfig,
  });

  assert.deepEqual(actions, [
    "send",
    "emoji-list",
    "react",
    "reactions",
    "read",
    "edit",
    "delete",
    "pin",
    "unpin",
    "list-pins",
    "member-info",
    "channel-info",
  ]);
});

test("omits gated action families from the advertised list", () => {
  const actions = matrixRustActions.listActions({
    cfg: {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret",
          actions: {
            reactions: false,
            messages: false,
            pins: false,
            memberInfo: false,
          },
        },
      },
    },
  });

  assert.deepEqual(actions, ["send", "emoji-list", "channel-info"]);
});

test("rejects disabled message actions before starting the native client", async () => {
  await assert.rejects(
    matrixRustActions.handleAction!({
      action: "read",
      params: {
        to: "!room:example.org",
      },
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            password: "secret",
            actions: {
              messages: false,
            },
          },
        },
      },
    }),
    /Matrix messages are disabled\./,
  );
});

test("rejects disabled pin actions before starting the native client", async () => {
  await assert.rejects(
    matrixRustActions.handleAction!({
      action: "pin",
      params: {
        to: "!room:example.org",
        messageId: "$event:example.org",
      },
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            password: "secret",
            actions: {
              pins: false,
            },
          },
        },
      },
    }),
    /Matrix pins are disabled\./,
  );
});
