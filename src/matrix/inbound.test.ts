import assert from "node:assert/strict";
import test from "node:test";

import { extractMatrixCustomEmojiUsageFromFormattedBody } from "./inbound.js";

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
