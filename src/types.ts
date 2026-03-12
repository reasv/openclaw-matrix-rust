import type {
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/matrix";

export type CoreConfig = OpenClawConfig;

export type MatrixThreadRepliesMode = "off" | "inbound" | "always";
export type MatrixReplyToMode = "off" | "first" | "all";
export type MatrixAutoJoinMode = "always" | "allowlist" | "off";
export type MatrixAuthMode = "password" | "accessToken";
export type MatrixSyncState = "stopped" | "starting" | "ready" | "error";
export type MatrixVerificationState = "disabled" | "pending" | "verified";
export type MatrixKeyBackupState = "disabled" | "pending" | "enabled";

export type MatrixRoomConfig = {
  enabled?: boolean;
  allow?: boolean;
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  autoReply?: boolean;
  users?: string[];
  skills?: string[];
  systemPrompt?: string;
  threadReplies?: MatrixThreadRepliesMode;
};

export type MatrixChannelAccountConfig = {
  name?: string;
  enabled?: boolean;
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
  recoveryKey?: string;
  deviceName?: string;
  initialSyncLimit?: number;
  encryption?: boolean;
  allowlistOnly?: boolean;
  groupPolicy?: GroupPolicy;
  replyToMode?: MatrixReplyToMode;
  threadReplies?: MatrixThreadRepliesMode;
  textChunkLimit?: number;
  mediaMaxMb?: number;
  autoJoin?: MatrixAutoJoinMode;
  groupAllowFrom?: string[];
  dm?: {
    policy?: DmPolicy;
    allowFrom?: string[];
  };
  groups?: Record<string, MatrixRoomConfig>;
  rooms?: Record<string, MatrixRoomConfig>;
  actions?: {
    reactions?: boolean;
    messages?: boolean;
    pins?: boolean;
    memberInfo?: boolean;
    channelInfo?: boolean;
  };
};

export type MatrixChannelConfig = MatrixChannelAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, MatrixChannelAccountConfig>;
};

export type ResolvedMatrixAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  homeserver?: string;
  userId?: string;
  authMode?: MatrixAuthMode;
  deviceName?: string;
  config: MatrixChannelAccountConfig;
};

export type MatrixNativeConfig = {
  accountId: string;
  homeserver: string;
  userId: string;
  auth:
    | { mode: "password"; password: string }
    | { mode: "accessToken"; accessToken: string };
  recoveryKey?: string;
  deviceName?: string;
  initialSyncLimit: number;
  encryptionEnabled: boolean;
  defaultThreadReplies: MatrixThreadRepliesMode;
  replyToMode: MatrixReplyToMode;
  stateLayout: {
    rootDir: string;
    sessionFile: string;
    sdkStoreDir: string;
    cryptoStoreDir: string;
    mediaCacheDir: string;
    emojiCatalogFile: string;
    reactionsFile: string;
    logsDir: string;
  };
  roomOverrides: Record<
    string,
    {
      threadReplies?: MatrixThreadRepliesMode;
      requireMention?: boolean;
    }
  >;
};

export type MatrixNativeLifecycleStage =
  | "load_session"
  | "init_stores"
  | "restore_or_login"
  | "persist_session"
  | "init_crypto"
  | "restore_recovery"
  | "enable_backup"
  | "start_sync";

export type MatrixNativeEvent =
  | {
      type: "lifecycle";
      stage: MatrixNativeLifecycleStage;
      detail: string;
      at: string;
    }
  | {
      type: "sync_state";
      state: MatrixSyncState;
      at: string;
    }
  | {
      type: "outbound";
      roomId: string;
      messageId: string;
      threadId?: string;
      replyToId?: string;
      at: string;
    };

export type MatrixNativeDiagnostics = {
  accountId: string;
  userId: string;
  deviceId: string;
  verificationState: MatrixVerificationState;
  keyBackupState: MatrixKeyBackupState;
  syncState: MatrixSyncState;
  lastSuccessfulSyncAt: string | null;
  lastSuccessfulDecryptionAt: string | null;
  startedAt: string | null;
};

export type MatrixSendRequest = {
  roomId: string;
  text: string;
  replyToId?: string;
  threadId?: string;
};

export type MatrixSendResult = {
  roomId: string;
  messageId: string;
  threadId?: string;
};

export type MatrixReactionKind = "unicode" | "custom" | "text";

export type MatrixReactionInfo = {
  raw: string;
  normalized: string;
  display: string;
  kind: MatrixReactionKind;
  shortcode?: string;
};

export type MatrixReactionSummary = {
  key: string;
  normalizedKey: string;
  display: string;
  kind: MatrixReactionKind;
  shortcode?: string;
  count: number;
  users: string[];
  rawKeys: string[];
};

export type MatrixReactRequest = {
  roomId: string;
  messageId: string;
  key: string;
  remove?: boolean;
  senderId?: string;
};

export type MatrixReactResult = {
  removed: number;
  reaction?: MatrixReactionInfo | null;
};

export type MatrixEmojiUsageRef = {
  shortcode: string;
  mxcUrl: string;
};

export type MatrixEmojiUsageRequest = {
  emoji: MatrixEmojiUsageRef[];
  roomId?: string;
  observedAtMs?: number;
};

export type MatrixListReactionsRequest = {
  roomId: string;
  messageId: string;
  limit?: number;
};

export type MatrixListEmojiRequest = {
  roomId?: string;
  limit?: number;
  nowMs?: number;
};
