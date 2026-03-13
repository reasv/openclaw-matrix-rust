declare module "openclaw/plugin-sdk/matrix" {
  export type DmPolicy = "open" | "allowlist" | "pairing" | "disabled";
  export type GroupPolicy = "open" | "allowlist" | "blocked" | "disabled";
  export type GroupToolPolicyConfig = Record<string, unknown>;
  export type AllowlistMatch<T extends string = string> = {
    allowed: boolean;
    matchKey?: string;
    matchSource?: T;
  };
  export type OpenClawConfig = {
    channels?: Record<string, unknown> & {
      defaults?: {
        groupPolicy?: GroupPolicy;
      };
      matrix?: unknown;
    };
    commands?: {
      useAccessGroups?: boolean;
    };
    messages?: {
      ackReaction?: string;
      ackReactionScope?:
        | "group-mentions"
        | "group-all"
        | "direct"
        | "all"
        | "off"
        | "none";
    };
  };

  export type PluginRuntime = {
    state: {
      resolveStateDir: (...args: unknown[]) => string;
    };
  };

  export type OpenClawPluginApi = {
    runtime: PluginRuntime;
    logger: {
      info: (message: string, meta?: Record<string, unknown>) => void;
      warn?: (message: string, meta?: Record<string, unknown>) => void;
    };
    registerChannel: (registration: { plugin: unknown } | unknown) => void;
  };

  export type ChannelMessageActionName =
    | "send"
    | "emoji-list"
    | "react"
    | "reactions"
    | "read"
    | "edit"
    | "delete"
    | "pin"
    | "unpin"
    | "list-pins"
    | "member-info"
    | "channel-info"
    | "poll";

  export type ChannelToolSend = {
    to: string;
  };

  export type ChannelMessageActionContext = {
    action: ChannelMessageActionName;
    params: Record<string, unknown>;
    cfg: OpenClawConfig;
    mediaLocalRoots?: readonly string[];
    accountId?: string | null;
  };

  export type ChannelMessageActionAdapter = {
    listActions: (params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
    }) => ChannelMessageActionName[];
    supportsAction?: (params: {
      action: ChannelMessageActionName;
      cfg: OpenClawConfig;
      accountId?: string | null;
    }) => boolean;
    extractToolSend?: (params: { args: Record<string, unknown> }) => ChannelToolSend | null;
    handleAction?: (ctx: ChannelMessageActionContext) => Promise<Record<string, unknown>>;
  };

  export type ChannelPlugin<ResolvedAccount = unknown> = {
    id: string;
    meta: Record<string, unknown>;
    capabilities: Record<string, unknown>;
    reload?: { configPrefixes: string[] };
    configSchema?: unknown;
    config: {
      listAccountIds: (cfg: OpenClawConfig) => string[];
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
      defaultAccountId?: (cfg: OpenClawConfig) => string;
      setAccountEnabled?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        enabled: boolean;
      }) => OpenClawConfig;
      deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
      isConfigured?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean;
      describeAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => Record<string, unknown>;
      resolveAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => Array<string | number> | undefined;
      formatAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        allowFrom: Array<string | number>;
      }) => string[];
    };
    pairing?: {
      idLabel: string;
      normalizeAllowEntry?: (entry: string) => string;
      notifyApproval?: (params: {
        id: string;
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => Promise<void>;
    };
    groups?: {
      resolveRequireMention?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        groupId?: string | null;
      }) => boolean | undefined;
      resolveToolPolicy?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        groupId?: string | null;
      }) => GroupToolPolicyConfig | undefined;
    };
    threading?: {
      resolveReplyToMode?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => string;
      buildToolContext?: (params: {
        context: {
          To?: string;
          MessageThreadId?: string | number | null;
          ReplyToId?: string | null;
        };
        hasRepliedRef: boolean;
      }) => Record<string, unknown>;
    };
    messaging?: {
      normalizeTarget?: (raw: string) => string | undefined;
      targetResolver?: {
        looksLikeId: (input: string) => boolean;
        hint: string;
      };
    };
    outbound?: {
      deliveryMode: "direct" | "gateway" | "hybrid";
      textChunkLimit?: number;
      sendText?: (params: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        mediaLocalRoots?: readonly string[];
        replyToId?: string | null;
        threadId?: string | number | null;
        accountId?: string | null;
      }) => Promise<Record<string, unknown>>;
      sendMedia?: (params: {
        cfg: OpenClawConfig;
        to: string;
        mediaUrl: string;
        text?: string | null;
        mediaLocalRoots?: readonly string[];
        replyToId?: string | null;
        threadId?: string | number | null;
        accountId?: string | null;
      }) => Promise<Record<string, unknown>>;
    };
    status?: {
      defaultRuntime?: Record<string, unknown>;
      collectStatusIssues?: (accounts: Record<string, unknown>[]) => unknown[];
      buildChannelSummary?: (params: {
        account: ResolvedAccount;
        cfg: OpenClawConfig;
        defaultAccountId: string;
        snapshot: Record<string, unknown>;
      }) => Promise<Record<string, unknown>> | Record<string, unknown>;
      buildAccountSnapshot?: (params: {
        account: ResolvedAccount;
        cfg: OpenClawConfig;
        runtime?: Record<string, unknown>;
      }) => Promise<Record<string, unknown>> | Record<string, unknown>;
    };
    gateway?: {
      startAccount?: (ctx: {
        cfg: OpenClawConfig;
        accountId: string;
        account: ResolvedAccount;
        abortSignal: AbortSignal;
        log?: {
          info: (message: string) => void;
          debug?: (message: string) => void;
        };
        setStatus: (next: Record<string, unknown>) => void;
      }) => Promise<void>;
    };
    actions?: ChannelMessageActionAdapter;
  };

  export const DEFAULT_ACCOUNT_ID: string;
  export const MarkdownConfigSchema: unknown;
  export const ToolPolicySchema: unknown;

  export function emptyPluginConfigSchema(): Record<string, unknown>;
  export function buildChannelConfigSchema(schema: unknown): unknown;
  export function collectStatusIssuesFromLastError(
    channel: string,
    accounts: Record<string, unknown>[],
  ): unknown[];
  export function normalizeAccountId(accountId?: string | null): string;
  export function setAccountEnabledInConfigSection(params: {
    cfg: OpenClawConfig;
    sectionKey: string;
    accountId: string;
    enabled: boolean;
    allowTopLevel?: boolean;
  }): OpenClawConfig;
  export function deleteAccountFromConfigSection(params: {
    cfg: OpenClawConfig;
    sectionKey: string;
    accountId: string;
    clearBaseFields?: string[];
  }): OpenClawConfig;
  export function readStringParam(
    params: Record<string, unknown>,
    key: string,
    opts?: { required?: boolean; allowEmpty?: boolean },
  ): string;
  export function readNumberParam(
    params: Record<string, unknown>,
    key: string,
    opts?: { integer?: boolean },
  ): number | undefined;
  export function createReplyPrefixOptions(params: Record<string, unknown>): {
    onModelSelected?: (...args: unknown[]) => void;
    [key: string]: unknown;
  };
  export function createScopedPairingAccess(params: Record<string, unknown>): {
    accountId: string;
    readAllowFromStore: () => Promise<string[]>;
    readStoreForDmPolicy: (provider: string, accountId: string) => Promise<string[]>;
    upsertPairingRequest: (params: {
      id: string;
      meta?: Record<string, string | undefined>;
    }) => Promise<{ code: string; created: boolean }>;
  };
  export function createTypingCallbacks(params: Record<string, unknown>): {
    onReplyStart: () => Promise<void>;
    onIdle?: () => void;
    onCleanup?: () => void;
  };
  export function dispatchReplyFromConfigWithSettledDispatcher(params: Record<string, unknown>): Promise<{
    queuedFinal: boolean;
    counts: { final: number };
  }>;
  export function evaluateGroupRouteAccessForPolicy(params: Record<string, unknown>): {
    allowed: boolean;
    reason: string;
  };
  export function resolveDefaultGroupPolicy(cfg: OpenClawConfig): GroupPolicy | undefined;
  export function resolveAllowlistProviderRuntimeGroupPolicy(params: {
    providerConfigPresent: boolean;
    groupPolicy?: GroupPolicy;
    defaultGroupPolicy?: GroupPolicy;
  }): {
    groupPolicy: GroupPolicy;
    providerMissingFallbackApplied: boolean;
  };
  export function formatAllowlistMatchMeta(match: Record<string, unknown>): string;
  export function logInboundDrop(params: Record<string, unknown>): void;
  export function resolveControlCommandGate(params: Record<string, unknown>): {
    commandAuthorized: boolean;
    shouldBlock: boolean;
  };
  export function buildChannelKeyCandidates(...keys: string[]): string[];
  export function resolveChannelEntryMatch(params: Record<string, unknown>): {
    entry?: unknown;
    key?: string;
    wildcardEntry?: unknown;
    wildcardKey?: string;
  };
  export function issuePairingChallenge(params: Record<string, unknown>): Promise<void>;
  export function readStoreAllowFromForDmPolicy(params: Record<string, unknown>): Promise<string[]>;
  export function resolveDmGroupAccessWithLists(params: Record<string, unknown>): {
    decision: "allow" | "block" | "pairing";
    effectiveAllowFrom: string[];
    effectiveGroupAllowFrom: string[];
  };
  export function resolveAllowlistMatchByCandidates(params: Record<string, unknown>): AllowlistMatch;
}

declare module "openclaw/plugin-sdk/compat" {
  export const AllowFromListSchema: any;
  export const GroupPolicySchema: any;
  export function buildNestedDmConfigSchema(): any;
}
