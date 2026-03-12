import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/matrix";
import { matrixRustActions } from "./actions.js";
import { MatrixRustConfigSchema } from "./config-schema.js";
import { getMatrixRustRuntime } from "./runtime.js";
import type {
  CoreConfig,
  MatrixNativeDiagnostics,
  MatrixNativeEvent,
  ResolvedMatrixAccount,
} from "./types.js";
import {
  listMatrixRustAccountIds,
  resolveDefaultMatrixRustAccountId,
  resolveMatrixRustAccount,
} from "./matrix/accounts.js";
import { resolveNativeConfig } from "./matrix/adapter/config.js";
import { MatrixNativeClient } from "./matrix/adapter/native-client.js";

const activeClients = new Map<string, MatrixNativeClient>();

const meta = {
  id: "matrix",
  label: "Matrix",
  selectionLabel: "Matrix (Rust core)",
  docsPath: "/channels/matrix",
  docsLabel: "matrix",
  blurb: "Matrix connector with Rust-managed lifecycle and state.",
  order: 70,
  quickstartAllowFrom: true,
};

export function getOrCreateMatrixClient(accountId: string): MatrixNativeClient {
  const normalized = normalizeAccountId(accountId);
  const existing = activeClients.get(normalized);
  if (existing) {
    return existing;
  }
  const next = new MatrixNativeClient();
  activeClients.set(normalized, next);
  return next;
}

function isClientReady(client: MatrixNativeClient): boolean {
  const diagnostics = client.diagnostics();
  return diagnostics.syncState !== "stopped" && Boolean(diagnostics.userId);
}

export function ensureMatrixClientStarted(account: ResolvedMatrixAccount): MatrixNativeClient {
  const client = getOrCreateMatrixClient(account.accountId);
  if (!isClientReady(client)) {
    client.start(
      resolveNativeConfig({
        account,
        runtime: getMatrixRustRuntime(),
      }),
    );
  }
  return client;
}

function destroyMatrixClient(accountId: string): void {
  activeClients.delete(normalizeAccountId(accountId));
}

function buildStatusFromDiagnostics(
  account: ResolvedMatrixAccount,
  diagnostics: MatrixNativeDiagnostics,
): Record<string, unknown> {
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    homeserver: account.homeserver ?? null,
    userId: diagnostics.userId,
    deviceId: diagnostics.deviceId,
    syncState: diagnostics.syncState,
    verificationState: diagnostics.verificationState,
    keyBackupState: diagnostics.keyBackupState,
    running: diagnostics.syncState !== "stopped",
    startedAt: diagnostics.startedAt,
    lastSuccessfulSyncAt: diagnostics.lastSuccessfulSyncAt,
    lastSuccessfulDecryptionAt: diagnostics.lastSuccessfulDecryptionAt,
  };
}

function handleNativeEvent(params: {
  event: MatrixNativeEvent;
  account: ResolvedMatrixAccount;
  log?: { info: (message: string) => void; debug?: (message: string) => void };
  setStatus: (next: Record<string, unknown>) => void;
  client: MatrixNativeClient;
}): void {
  const { event, account, log, setStatus, client } = params;
  if (event.type === "lifecycle") {
    log?.info?.(`[matrix:${account.accountId}] ${event.stage}: ${event.detail}`);
    return;
  }
  if (event.type === "sync_state") {
    const diagnostics = client.diagnostics();
    setStatus(buildStatusFromDiagnostics(account, diagnostics));
    log?.info?.(`[matrix:${account.accountId}] sync_state=${event.state}`);
    return;
  }
  log?.debug?.(
    `[matrix:${account.accountId}] queued outbound ${event.messageId} -> ${event.roomId}`,
  );
}

function normalizeMatrixTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^matrix:/i, "").trim() || undefined;
}

function resolveRequireMention(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  groupId?: string | null;
}): boolean {
  const account = resolveMatrixRustAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const roomId = params.groupId?.trim();
  if (!roomId) {
    return true;
  }
  const room = account.config.rooms?.[roomId] ?? account.config.groups?.[roomId];
  if (room?.requireMention !== undefined) {
    return room.requireMention;
  }
  return true;
}

export const matrixRustPlugin: ChannelPlugin<ResolvedMatrixAccount> = {
  id: "matrix",
  meta,
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    threads: true,
    reactions: false,
    media: false,
  },
  reload: { configPrefixes: ["channels.matrix"] },
  configSchema: buildChannelConfigSchema(MatrixRustConfigSchema),
  config: {
    listAccountIds: (cfg) => listMatrixRustAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveMatrixRustAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMatrixRustAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "matrix",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "matrix",
        accountId,
        clearBaseFields: [
          "name",
          "homeserver",
          "userId",
          "accessToken",
          "password",
          "recoveryKey",
          "deviceName",
          "initialSyncLimit",
        ],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      homeserver: account.homeserver ?? null,
      userId: account.userId ?? null,
      authMode: account.authMode ?? null,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveMatrixRustAccount({ cfg: cfg as CoreConfig, accountId }).config.dm?.allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^matrix:/i, "")),
  },
  pairing: {
    idLabel: "matrixUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^matrix:/i, ""),
    notifyApproval: async ({ id, cfg, accountId }) => {
      const account = resolveMatrixRustAccount({ cfg: cfg as CoreConfig, accountId });
      const client = ensureMatrixClientStarted(account);
      try {
        client.sendMessage({
          roomId: `user:${id}`,
          text: "Your pairing request has been approved.",
        });
      } catch {
        // The approval message is best-effort until inbound lifecycle is implemented.
      }
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) =>
      resolveRequireMention({
        cfg: cfg as CoreConfig,
        accountId,
        groupId,
      }),
    resolveToolPolicy: ({ cfg, accountId, groupId }) => {
      const account = resolveMatrixRustAccount({
        cfg: cfg as CoreConfig,
        accountId,
      });
      if (!groupId) {
        return undefined;
      }
      return (
        account.config.rooms?.[groupId]?.tools ??
        account.config.groups?.[groupId]?.tools
      );
    },
  },
  threading: {
    resolveReplyToMode: ({ cfg, accountId }) =>
      resolveMatrixRustAccount({
        cfg: cfg as CoreConfig,
        accountId,
      }).config.replyToMode ?? "off",
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentThreadTs:
        context.MessageThreadId != null ? String(context.MessageThreadId) : context.ReplyToId,
      hasRepliedRef,
    }),
  },
  messaging: {
    normalizeTarget: normalizeMatrixTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        return Boolean(trimmed) && (/^(matrix:)?[!#@]/i.test(trimmed) || trimmed.includes(":"));
      },
      hint: "<room|alias|user>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, replyToId, threadId, accountId }) => {
      const account = resolveMatrixRustAccount({
        cfg: cfg as CoreConfig,
        accountId,
      });
      const client = ensureMatrixClientStarted(account);
      const result = client.sendMessage({
        roomId: to,
        text: text ?? "",
        replyToId: replyToId ?? undefined,
        threadId: threadId == null ? undefined : String(threadId),
      });
      return {
        channel: "matrix" as const,
        to,
        messageId: result.messageId,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      syncState: "stopped",
      verificationState: "disabled",
      keyBackupState: "disabled",
      lastError: null,
    },
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("matrix", accounts),
    buildChannelSummary: async ({ account }) => {
      const client = activeClients.get(account.accountId);
      const diagnostics = client?.diagnostics();
      return {
        configured: account.configured,
        homeserver: account.homeserver ?? null,
        userId: diagnostics?.userId ?? account.userId ?? null,
        deviceId: diagnostics?.deviceId ?? null,
        running: diagnostics ? diagnostics.syncState !== "stopped" : false,
        syncState: diagnostics?.syncState ?? "stopped",
      };
    },
    buildAccountSnapshot: async ({ account, runtime }) => {
      const client = activeClients.get(account.accountId);
      if (!client) {
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          homeserver: account.homeserver ?? null,
          userId: account.userId ?? null,
          running: false,
          syncState: "stopped",
          verificationState: "disabled",
          keyBackupState: "disabled",
          lastError: runtime?.lastError ?? null,
        };
      }
      return {
        ...buildStatusFromDiagnostics(account, client.diagnostics()),
        lastError: runtime?.lastError ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.enabled) {
        return;
      }
      if (!account.configured) {
        throw new Error(`Matrix account ${account.accountId} is not configured`);
      }

      const client = getOrCreateMatrixClient(account.accountId);
      const diagnostics = client.start(
        resolveNativeConfig({
          account,
          runtime: getMatrixRustRuntime(),
        }),
      );
      ctx.setStatus(buildStatusFromDiagnostics(account, diagnostics));

      try {
        while (!ctx.abortSignal.aborted) {
          const events = client.pollEvents();
          for (const event of events) {
            handleNativeEvent({
              event,
              account,
              log: ctx.log,
              setStatus: ctx.setStatus,
              client,
            });
          }
          await sleep(250, ctx.abortSignal);
        }
      } finally {
        client.stop();
        destroyMatrixClient(account.accountId);
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          syncState: "stopped",
        });
      }
    },
  },
  actions: matrixRustActions,
};

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
