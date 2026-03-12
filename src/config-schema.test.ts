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
