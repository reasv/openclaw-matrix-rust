import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMatrixHistoryScopeKey,
  createMatrixRoomHistoryBuffer,
} from "./history-buffer.js";

test("builds account-scoped room history keys", () => {
  assert.equal(
    buildMatrixHistoryScopeKey({
      accountId: "work",
      roomId: "!room:example.org",
    }),
    "work:!room:example.org",
  );
  assert.equal(
    buildMatrixHistoryScopeKey({
      accountId: "work",
      roomId: "!room:example.org",
      threadRootId: "$thread",
    }),
    "work:!room:example.org:thread:$thread",
  );
});

test("stores entries per scope and caps old entries", () => {
  const buffer = createMatrixRoomHistoryBuffer(2);

  buffer.add("work:room-a", { sender: "alice", body: "one" });
  buffer.add("work:room-a", { sender: "bob", body: "two" });
  buffer.add("work:room-a", { sender: "carol", body: "three" });
  buffer.add("personal:room-a", { sender: "dave", body: "other" });

  assert.deepEqual(buffer.snapshot("work:room-a"), [
    { sender: "bob", body: "two" },
    { sender: "carol", body: "three" },
  ]);
  assert.deepEqual(buffer.snapshot("personal:room-a"), [{ sender: "dave", body: "other" }]);
});

test("isolates histories for accounts sharing the same room id", () => {
  const buffer = createMatrixRoomHistoryBuffer(5);
  const roomId = "!room:example.org";
  const workScope = buildMatrixHistoryScopeKey({
    accountId: "work",
    roomId,
  });
  const personalScope = buildMatrixHistoryScopeKey({
    accountId: "personal",
    roomId,
  });

  buffer.add(workScope, { sender: "alice", body: "from work" });
  buffer.add(personalScope, { sender: "bob", body: "from personal" });

  assert.deepEqual(buffer.snapshot(workScope), [{ sender: "alice", body: "from work" }]);
  assert.deepEqual(buffer.snapshot(personalScope), [{ sender: "bob", body: "from personal" }]);
});

test("returns an empty buffer when maxEntries is zero", () => {
  const buffer = createMatrixRoomHistoryBuffer(0);

  buffer.add("work:room-a", { sender: "alice", body: "one" });
  buffer.add("work:room-a", { sender: "bob", body: "two" });

  assert.deepEqual(buffer.snapshot("work:room-a"), []);
});

test("clears a scope without affecting others", () => {
  const buffer = createMatrixRoomHistoryBuffer(5);

  buffer.add("work:room-a", { sender: "alice", body: "one" });
  buffer.add("personal:room-a", { sender: "bob", body: "two" });

  buffer.clear("work:room-a");

  assert.deepEqual(buffer.snapshot("work:room-a"), []);
  assert.deepEqual(buffer.snapshot("personal:room-a"), [{ sender: "bob", body: "two" }]);
});
