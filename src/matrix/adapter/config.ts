import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import type { MatrixNativeConfig, ResolvedMatrixAccount } from "../../types.js";

export function resolveNativeConfig(params: {
  account: ResolvedMatrixAccount;
  runtime: PluginRuntime;
}): MatrixNativeConfig {
  const { account, runtime } = params;
  const rootDir = path.join(runtime.state.resolveStateDir(), "plugins", "matrix-rust", account.accountId);
  const password = account.config.password?.trim();
  const accessToken = account.config.accessToken?.trim();
  if (!account.homeserver?.trim()) {
    throw new Error(`Matrix account ${account.accountId} is missing homeserver`);
  }
  if (!account.userId?.trim()) {
    throw new Error(`Matrix account ${account.accountId} is missing userId`);
  }
  if (!password && !accessToken) {
    throw new Error(`Matrix account ${account.accountId} is missing password or accessToken`);
  }

  const roomEntries = Object.entries(account.config.rooms ?? {});
  const roomOverrides = Object.fromEntries(
    roomEntries.map(([roomId, room]) => [
      roomId,
      {
        threadReplies: room?.threadReplies,
        requireMention: room?.requireMention,
      },
    ]),
  );

  return {
    accountId: account.accountId,
    homeserver: account.homeserver,
    userId: account.userId,
    auth: password
      ? { mode: "password", password }
      : {
          mode: "accessToken",
          accessToken: accessToken as string,
        },
    recoveryKey: account.config.recoveryKey?.trim() || undefined,
    deviceName: account.deviceName?.trim() || "OpenClaw Matrix Rust",
    initialSyncLimit: account.config.initialSyncLimit ?? 50,
    encryptionEnabled: account.config.encryption ?? true,
    defaultThreadReplies: account.config.threadReplies ?? "inbound",
    replyToMode: account.config.replyToMode ?? "off",
    stateLayout: {
      rootDir,
      sessionFile: path.join(rootDir, "session.json"),
      sdkStoreDir: path.join(rootDir, "sdk-store"),
      cryptoStoreDir: path.join(rootDir, "crypto-store"),
      mediaCacheDir: path.join(rootDir, "media-cache"),
      emojiCatalogFile: path.join(rootDir, "emoji-catalog.json"),
      reactionsFile: path.join(rootDir, "reactions.json"),
      logsDir: path.join(rootDir, "logs"),
    },
    roomOverrides,
  };
}
