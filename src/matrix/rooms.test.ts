import test from "node:test";
import assert from "node:assert/strict";
import { resolveMatrixRoomConfig } from "./rooms.js";

test("prefers direct room matches over wildcard", () => {
  const resolved = resolveMatrixRoomConfig({
    rooms: {
      "*": { requireMention: false },
      "!room:example.org": { requireMention: true },
    },
    roomId: "!room:example.org",
    aliases: [],
  });

  assert.equal(resolved.matchSource, "direct");
  assert.equal(resolved.config?.requireMention, true);
});

test("falls back to wildcard room config", () => {
  const resolved = resolveMatrixRoomConfig({
    rooms: {
      "*": { requireMention: false },
    },
    roomId: "!room:example.org",
    aliases: [],
  });

  assert.equal(resolved.matchSource, "wildcard");
  assert.equal(resolved.config?.requireMention, false);
});
