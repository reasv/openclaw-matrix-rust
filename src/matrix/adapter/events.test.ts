import assert from "node:assert/strict";
import test from "node:test";

import { decodeNativeEvents } from "./events.js";

test("decodeNativeEvents normalizes outbound snake_case fields", () => {
  const events = decodeNativeEvents(
    JSON.stringify([
      {
        type: "outbound",
        room_id: "!room:example.org",
        message_id: "$event",
        thread_id: "$thread",
        reply_to_id: "$parent",
        at: "2026-03-15T00:00:00.000Z",
      },
    ]),
  );

  assert.deepEqual(events, [
    {
      type: "outbound",
      roomId: "!room:example.org",
      messageId: "$event",
      threadId: "$thread",
      replyToId: "$parent",
      at: "2026-03-15T00:00:00.000Z",
    },
  ]);
});
