import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { matrixRustActions, summarizeReactionsForTool } from "./actions.js";
import { MatrixNativeClient } from "./matrix/adapter/native-client.js";
import { setMatrixRustRuntime } from "./runtime.js";
import type { CoreConfig, MatrixReactionSummary } from "./types.js";

const baseConfig: CoreConfig = {
  channels: {
    matrix: {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "secret",
    },
  },
};

const originalDiagnostics = MatrixNativeClient.prototype.diagnostics;
const originalSendMessage = MatrixNativeClient.prototype.sendMessage;
const originalUploadMedia = MatrixNativeClient.prototype.uploadMedia;
const originalReadMessages = MatrixNativeClient.prototype.readMessages;
const originalMessageSummary = MatrixNativeClient.prototype.messageSummary;
const originalDownloadMedia = MatrixNativeClient.prototype.downloadMedia;
let saveMediaBufferCalls: Array<{
  contentType?: string;
  filename?: string;
  sizeBytes: number;
}> = [];

function installReadyClient(params: {
  sendMessage?: (request: Record<string, unknown>) => Record<string, unknown>;
  uploadMedia?: (request: Record<string, unknown>) => Record<string, unknown>;
  readMessages?: (request: Record<string, unknown>) => Record<string, unknown>;
  messageSummary?: (request: Record<string, unknown>) => Record<string, unknown> | null;
  downloadMedia?: (request: Record<string, unknown>) => Record<string, unknown>;
}) {
  MatrixNativeClient.prototype.diagnostics = function diagnostics() {
    return {
      accountId: "default",
      userId: "@bot:example.org",
      deviceId: "DEVICE",
      verificationState: "verified",
      keyBackupState: "enabled",
      syncState: "ready",
      lastSuccessfulSyncAt: null,
      lastSuccessfulDecryptionAt: null,
      startedAt: null,
    };
  };
  MatrixNativeClient.prototype.sendMessage = function sendMessage(request) {
    if (!params.sendMessage) {
      throw new Error("unexpected sendMessage");
    }
    return params.sendMessage(request as Record<string, unknown>) as any;
  };
  MatrixNativeClient.prototype.uploadMedia = function uploadMedia(request) {
    if (!params.uploadMedia) {
      throw new Error("unexpected uploadMedia");
    }
    return params.uploadMedia(request as Record<string, unknown>) as any;
  };
  MatrixNativeClient.prototype.readMessages = function readMessages(request) {
    if (!params.readMessages) {
      throw new Error("unexpected readMessages");
    }
    return params.readMessages(request as Record<string, unknown>) as any;
  };
  MatrixNativeClient.prototype.messageSummary = function messageSummary(request) {
    if (!params.messageSummary) {
      throw new Error("unexpected messageSummary");
    }
    return params.messageSummary(request as Record<string, unknown>) as any;
  };
  MatrixNativeClient.prototype.downloadMedia = function downloadMedia(request) {
    if (!params.downloadMedia) {
      throw new Error("unexpected downloadMedia");
    }
    return params.downloadMedia(request as Record<string, unknown>) as any;
  };
}

beforeEach(() => {
  saveMediaBufferCalls = [];
  setMatrixRustRuntime({
    state: {
      resolveStateDir: () => "/tmp/openclaw-test-state",
    },
    media: {
      loadWebMedia: async () => {
        throw new Error("unexpected loadWebMedia");
      },
    },
    channel: {
      media: {
        fetchRemoteMedia: async () => {
          throw new Error("unexpected fetchRemoteMedia");
        },
        saveMediaBuffer: async (
          buffer: Buffer,
          contentType?: string,
          _kind?: string,
          _maxBytes?: number,
          filename?: string,
        ) => {
          saveMediaBufferCalls.push({
            contentType,
            filename,
            sizeBytes: buffer.length,
          });
          return {
            path: `/tmp/${filename ?? "attachment"}`,
            contentType: contentType ?? "application/octet-stream",
            sizeBytes: buffer.length,
          };
        },
      },
    },
  } as any);
});

afterEach(() => {
  MatrixNativeClient.prototype.diagnostics = originalDiagnostics;
  MatrixNativeClient.prototype.sendMessage = originalSendMessage;
  MatrixNativeClient.prototype.uploadMedia = originalUploadMedia;
  MatrixNativeClient.prototype.readMessages = originalReadMessages;
  MatrixNativeClient.prototype.messageSummary = originalMessageSummary;
  MatrixNativeClient.prototype.downloadMedia = originalDownloadMedia;
});

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

test("reduces reaction summaries to agent-facing fields", () => {
  const reduced = summarizeReactionsForTool([
    {
      key: "mxc://example.org/blobwave",
      normalizedKey: "mxc://example.org/blobwave",
      display: ":blobwave:",
      kind: "custom",
      shortcode: ":blobwave:",
      count: 2,
      users: ["@a:example.org", "@b:example.org"],
      rawKeys: ["mxc://example.org/blobwave"],
    } satisfies MatrixReactionSummary,
  ]);

  assert.deepEqual(reduced, [
    {
      display: ":blobwave:",
      shortcode: ":blobwave:",
      kind: "custom",
      count: 2,
      users: ["@a:example.org", "@b:example.org"],
    },
  ]);
});

test("read action keeps timeline reads unchanged when no eventId is supplied", async () => {
  const readMessagesCalls: Array<Record<string, unknown>> = [];
  installReadyClient({
    readMessages: (request) => {
      readMessagesCalls.push(request);
      return {
        messages: [
          {
            eventId: "$one",
            sender: "@alice:example.org",
            body: "hello",
            timestamp: "2026-03-14T12:00:00.000Z",
          },
        ],
        nextBatch: null,
        prevBatch: null,
      };
    },
  });

  const result = await matrixRustActions.handleAction!({
    action: "read",
    params: {
      to: "!room:example.org",
      limit: 5,
    },
    cfg: baseConfig,
  });

  assert.deepEqual(readMessagesCalls, [
    {
      roomId: "!room:example.org",
      limit: 5,
      before: undefined,
      after: undefined,
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    messages: [
      {
        eventId: "$one",
        sender: "@alice:example.org",
        body: "hello",
        timestamp: "2026-03-14T12:00:00.000Z",
      },
    ],
    nextBatch: null,
    prevBatch: null,
  });
});

test("read action can include an image block for a single event without host persistence", async () => {
  const messageSummaryCalls: Array<Record<string, unknown>> = [];
  const downloadMediaCalls: Array<Record<string, unknown>> = [];
  installReadyClient({
    messageSummary: (request) => {
      messageSummaryCalls.push(request);
      return {
        eventId: "$event",
        sender: "@alice:example.org",
        body: "see attached",
        timestamp: "2026-03-14T12:00:00.000Z",
      };
    },
    downloadMedia: (request) => {
      downloadMediaCalls.push(request);
      return {
        roomId: "!room:example.org",
        eventId: "$event",
        kind: "image",
        filename: "photo.jpg",
        contentType: "image/jpeg",
        dataBase64: Buffer.from("jpeg-bytes").toString("base64"),
      };
    },
  });

  const result = await matrixRustActions.handleAction!({
    action: "read",
    params: {
      to: "!room:example.org",
      eventId: "$event",
      includeImage: true,
    },
    cfg: baseConfig,
  });

  assert.deepEqual(messageSummaryCalls, [
    {
      roomId: "!room:example.org",
      eventId: "$event",
    },
  ]);
  assert.deepEqual(downloadMediaCalls, [
    {
      roomId: "!room:example.org",
      eventId: "$event",
    },
  ]);
  assert.deepEqual(saveMediaBufferCalls, []);
  assert.deepEqual(result, {
    ok: true,
    roomId: "!room:example.org",
    eventId: "$event",
    message: {
      eventId: "$event",
      sender: "@alice:example.org",
      body: "see attached",
      timestamp: "2026-03-14T12:00:00.000Z",
    },
    media: [],
    content: [
      {
        type: "text",
        text: 'Retrieved image attachment for $event: filename="photo.jpg" type="image/jpeg"',
      },
      {
        type: "image",
        data: Buffer.from("jpeg-bytes").toString("base64"),
        mimeType: "image/jpeg",
        fileName: "photo.jpg",
      },
    ],
  });
});

test("read action can stage an image into an agent-visible root", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-read-download-"));
  const messageSummaryCalls: Array<Record<string, unknown>> = [];
  const downloadMediaCalls: Array<Record<string, unknown>> = [];
  installReadyClient({
    messageSummary: (request) => {
      messageSummaryCalls.push(request);
      return {
        eventId: "$event",
        sender: "@alice:example.org",
        body: "see attached",
        timestamp: "2026-03-14T12:00:00.000Z",
      };
    },
    downloadMedia: (request) => {
      downloadMediaCalls.push(request);
      return {
        roomId: "!room:example.org",
        eventId: "$event",
        kind: "image",
        filename: "photo.jpg",
        contentType: "image/jpeg",
        dataBase64: Buffer.from("jpeg-bytes").toString("base64"),
      };
    },
  });

  const result = (await matrixRustActions.handleAction!({
    action: "read",
    params: {
      to: "!room:example.org",
      eventId: "$event",
      downloadImage: true,
    },
    cfg: baseConfig,
    mediaLocalRoots: ["/tmp/openclaw-state/media", tempRoot],
  })) as Record<string, unknown>;

  assert.deepEqual(messageSummaryCalls, [
    {
      roomId: "!room:example.org",
      eventId: "$event",
    },
  ]);
  assert.deepEqual(downloadMediaCalls, [
    {
      roomId: "!room:example.org",
      eventId: "$event",
    },
  ]);
  assert.deepEqual(saveMediaBufferCalls, []);

  const media = result.media as Array<Record<string, unknown>>;
  assert.equal(media.length, 1);
  const stagedPath = media[0]?.stagedPath;
  assert.equal(typeof stagedPath, "string");
  assert.match(String(stagedPath), new RegExp(`${tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*downloads`));
  assert.equal(await fs.readFile(String(stagedPath), "utf8"), "jpeg-bytes");

  assert.deepEqual(result, {
    ok: true,
    roomId: "!room:example.org",
    eventId: "$event",
    message: {
      eventId: "$event",
      sender: "@alice:example.org",
      body: "see attached",
      timestamp: "2026-03-14T12:00:00.000Z",
    },
    media: [
      {
        eventId: "$event",
        kind: "image",
        filename: "photo.jpg",
        contentType: "image/jpeg",
        stagedPath,
        stagedContentType: "image/jpeg",
      },
    ],
    details: {
      downloadImage: {
        eventId: "$event",
        filename: "photo.jpg",
        contentType: "image/jpeg",
        path: stagedPath,
      },
    },
  });
});

test("read action keeps legacy includeMedia persistence behavior", async () => {
  installReadyClient({
    messageSummary: () => ({
      eventId: "$event",
      sender: "@alice:example.org",
      body: "see attached",
      timestamp: "2026-03-14T12:00:00.000Z",
    }),
    downloadMedia: () => ({
      roomId: "!room:example.org",
      eventId: "$event",
      kind: "image",
      filename: "photo.jpg",
      contentType: "image/jpeg",
      dataBase64: Buffer.from("jpeg-bytes").toString("base64"),
    }),
  });

  const result = await matrixRustActions.handleAction!({
    action: "read",
    params: {
      to: "!room:example.org",
      eventId: "$event",
      includeMedia: true,
    },
    cfg: baseConfig,
  });

  assert.deepEqual(saveMediaBufferCalls, [
    {
      contentType: "image/jpeg",
      filename: "photo.jpg",
      sizeBytes: "jpeg-bytes".length,
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    roomId: "!room:example.org",
    eventId: "$event",
    message: {
      eventId: "$event",
      sender: "@alice:example.org",
      body: "see attached",
      timestamp: "2026-03-14T12:00:00.000Z",
    },
    media: [
      {
        eventId: "$event",
        kind: "image",
        filename: "photo.jpg",
        contentType: "image/jpeg",
        savedPath: "/tmp/photo.jpg",
        savedContentType: "image/jpeg",
      },
    ],
  });
});

test("send action keeps text-only sends on sendMessage", async () => {
  const sendMessageCalls: Array<Record<string, unknown>> = [];
  installReadyClient({
    sendMessage: (request) => {
      sendMessageCalls.push(request);
      return {
        roomId: String(request.roomId),
        messageId: "$text",
      };
    },
  });

  const result = await matrixRustActions.handleAction!({
    action: "send",
    params: {
      to: "!room:example.org",
      message: "hello from matrix",
      replyTo: "$parent",
      threadId: "$thread",
    },
    cfg: baseConfig,
  });

  assert.deepEqual(result, {
    ok: true,
    channel: "matrix",
    roomId: "!room:example.org",
    messageId: "$text",
  });
  assert.deepEqual(sendMessageCalls, [
    {
      roomId: "!room:example.org",
      text: "hello from matrix",
      replyToId: "$parent",
      threadId: "$thread",
    },
  ]);
});

test("send action uploads local media with caption and trusted mediaLocalRoots", async () => {
  const loadWebMediaCalls: Array<{ mediaUrl: string; options: Record<string, unknown> }> = [];
  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime({
    state: {
      resolveStateDir: () => "/tmp/openclaw-test-state",
    },
    media: {
      loadWebMedia: async (mediaUrl: string, options?: Record<string, unknown>) => {
        loadWebMediaCalls.push({ mediaUrl, options: options ?? {} });
        return {
          buffer: Buffer.from("pdf-bytes"),
          contentType: "application/pdf",
          fileName: "report.pdf",
        };
      },
    },
    channel: {
      media: {
        fetchRemoteMedia: async () => {
          throw new Error("unexpected fetchRemoteMedia");
        },
      },
    },
  } as any);
  installReadyClient({
    uploadMedia: (request) => {
      uploadMediaCalls.push(request);
      return {
        roomId: String(request.roomId),
        messageId: "$file",
        filename: String(request.filename),
        contentType: String(request.contentType),
      };
    },
  });

  const result = await matrixRustActions.handleAction!({
    action: "send",
    params: {
      to: "!room:example.org",
      message: "Quarterly report",
      media: "./out/report.pdf",
      replyTo: "$parent",
      threadId: "$thread",
    },
    cfg: baseConfig,
    mediaLocalRoots: ["/tmp/agent-root"],
  });

  assert.deepEqual(result, {
    ok: true,
    channel: "matrix",
    roomId: "!room:example.org",
    messageId: "$file",
  });
  assert.deepEqual(loadWebMediaCalls, [
    {
      mediaUrl: "./out/report.pdf",
      options: {
        maxBytes: 20 * 1024 * 1024,
        localRoots: ["/tmp/agent-root"],
      },
    },
  ]);
  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "report.pdf",
      contentType: "application/pdf",
      dataBase64: Buffer.from("pdf-bytes").toString("base64"),
      caption: "Quarterly report",
      replyToId: "$parent",
      threadId: "$thread",
    },
  ]);
});

test("send action accepts attachment-only sends via filePath alias", async () => {
  const loadWebMediaCalls: Array<{ mediaUrl: string; options: Record<string, unknown> }> = [];
  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime({
    state: {
      resolveStateDir: () => "/tmp/openclaw-test-state",
    },
    media: {
      loadWebMedia: async (mediaUrl: string, options?: Record<string, unknown>) => {
        loadWebMediaCalls.push({ mediaUrl, options: options ?? {} });
        return {
          buffer: Buffer.from("image-bytes"),
          contentType: "image/png",
          fileName: "render.png",
        };
      },
    },
    channel: {
      media: {
        fetchRemoteMedia: async () => {
          throw new Error("unexpected fetchRemoteMedia");
        },
      },
    },
  } as any);
  installReadyClient({
    uploadMedia: (request) => {
      uploadMediaCalls.push(request);
      return {
        roomId: String(request.roomId),
        messageId: "$media-only",
        filename: String(request.filename),
        contentType: String(request.contentType),
      };
    },
  });

  const result = await matrixRustActions.handleAction!({
    action: "send",
    params: {
      to: "!room:example.org",
      filePath: "./out/render.png",
    },
    cfg: baseConfig,
    mediaLocalRoots: ["/tmp/agent-root"],
  });

  assert.deepEqual(result, {
    ok: true,
    channel: "matrix",
    roomId: "!room:example.org",
    messageId: "$media-only",
  });
  assert.deepEqual(loadWebMediaCalls, [
    {
      mediaUrl: "./out/render.png",
      options: {
        maxBytes: 20 * 1024 * 1024,
        localRoots: ["/tmp/agent-root"],
      },
    },
  ]);
  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "render.png",
      contentType: "image/png",
      dataBase64: Buffer.from("image-bytes").toString("base64"),
      caption: undefined,
      replyToId: undefined,
      threadId: undefined,
    },
  ]);
});
