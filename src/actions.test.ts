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
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
  "base64",
);
const TINY_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");

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
        ) => ({
          path: `/tmp/${filename ?? "attachment"}`,
          contentType: contentType ?? "application/octet-stream",
          sizeBytes: buffer.length,
        }),
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

test("describeMessageTool exposes the current action surface", () => {
  const discovery = matrixRustActions.describeMessageTool?.({
    cfg: baseConfig,
  });

  assert.deepEqual(discovery, {
    actions: [
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
    ],
    capabilities: [],
  });
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

test("read action can retrieve a single event summary", async () => {
  const messageSummaryCalls: Array<Record<string, unknown>> = [];
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
  });

  const result = await matrixRustActions.handleAction!({
    action: "read",
    params: {
      to: "!room:example.org",
      eventId: "$event",
    },
    cfg: baseConfig,
  });

  assert.deepEqual(messageSummaryCalls, [
    {
      roomId: "!room:example.org",
      eventId: "$event",
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
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-action-send-pdf-"));
  const mediaPath = path.join(workspaceDir, "report.pdf");
  await fs.writeFile(mediaPath, TINY_PDF);
  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  const sendMessageCalls: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime({
    state: {
      resolveStateDir: () => "/tmp/openclaw-test-state",
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
    sendMessage: (request) => {
      sendMessageCalls.push(request);
      return {
        roomId: String(request.roomId),
        messageId: "$caption",
      };
    },
  });

  const result = await matrixRustActions.handleAction!({
    action: "send",
    params: {
      to: "!room:example.org",
      message: "Quarterly report",
      media: mediaPath,
      replyTo: "$parent",
      threadId: "$thread",
    },
    cfg: baseConfig,
    mediaLocalRoots: [workspaceDir],
  });

  assert.deepEqual(result, {
    ok: true,
    channel: "matrix",
    roomId: "!room:example.org",
    messageId: "$file",
  });
  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "report.pdf",
      contentType: "application/pdf",
      dataBase64: TINY_PDF.toString("base64"),
      caption: undefined,
      replyToId: "$parent",
      threadId: "$thread",
    },
  ]);
  assert.deepEqual(sendMessageCalls, [
    {
      roomId: "!room:example.org",
      text: "Quarterly report",
      threadId: "$thread",
    },
  ]);
});

test("send action sends attachment captions as a follow-up text event", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-action-send-png-"));
  const mediaPath = path.join(workspaceDir, "render.png");
  await fs.writeFile(mediaPath, TINY_PNG);
  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  const sendMessageCalls: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime({
    state: {
      resolveStateDir: () => "/tmp/openclaw-test-state",
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
        messageId: "$image",
        filename: String(request.filename),
        contentType: String(request.contentType),
      };
    },
    sendMessage: (request) => {
      sendMessageCalls.push(request);
      return {
        roomId: String(request.roomId),
        messageId: "$caption",
      };
    },
  });

  const result = await matrixRustActions.handleAction!({
    action: "send",
    params: {
      to: "!room:example.org",
      message: "Render result",
      media: mediaPath,
      replyTo: "$parent",
      threadId: "$thread",
    },
    cfg: baseConfig,
    mediaLocalRoots: [workspaceDir],
  });

  assert.deepEqual(result, {
    ok: true,
    channel: "matrix",
    roomId: "!room:example.org",
    messageId: "$image",
  });
  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "render.png",
      contentType: "image/png",
      dataBase64: TINY_PNG.toString("base64"),
      caption: undefined,
      replyToId: "$parent",
      threadId: "$thread",
    },
  ]);
  assert.deepEqual(sendMessageCalls, [
    {
      roomId: "!room:example.org",
      text: "Render result",
      threadId: "$thread",
    },
  ]);
});

test("send action accepts attachment-only sends via filePath alias", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-action-send-filepath-"));
  const mediaPath = path.join(workspaceDir, "render.png");
  await fs.writeFile(mediaPath, TINY_PNG);
  const uploadMediaCalls: Array<Record<string, unknown>> = [];
  setMatrixRustRuntime({
    state: {
      resolveStateDir: () => "/tmp/openclaw-test-state",
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
      filePath: mediaPath,
    },
    cfg: baseConfig,
    mediaLocalRoots: [workspaceDir],
  });

  assert.deepEqual(result, {
    ok: true,
    channel: "matrix",
    roomId: "!room:example.org",
    messageId: "$media-only",
  });
  assert.deepEqual(uploadMediaCalls, [
    {
      roomId: "!room:example.org",
      filename: "render.png",
      contentType: "image/png",
      dataBase64: TINY_PNG.toString("base64"),
      caption: undefined,
      replyToId: undefined,
      threadId: undefined,
    },
  ]);
});
