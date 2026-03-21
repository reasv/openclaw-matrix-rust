import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPendingMatrixUserProfileHints,
  setPendingMatrixUserProfileHint,
  takePendingMatrixUserProfileHint,
} from "./runtime.js";

test("pending matrix user profile hints are one-shot per session key", () => {
  clearPendingMatrixUserProfileHints();
  setPendingMatrixUserProfileHint("agent:main:matrix:test", "[User profile] Available for this sender.");

  assert.equal(
    takePendingMatrixUserProfileHint("agent:main:matrix:test"),
    "[User profile] Available for this sender.",
  );
  assert.equal(takePendingMatrixUserProfileHint("agent:main:matrix:test"), undefined);
});
