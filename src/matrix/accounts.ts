import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/matrix";
import type { CoreConfig, MatrixChannelAccountConfig, MatrixChannelConfig, ResolvedMatrixAccount } from "../types.js";

function resolveMatrixSection(cfg: CoreConfig): MatrixChannelConfig | undefined {
  return cfg.channels?.matrix as MatrixChannelConfig | undefined;
}

function extractDefaultAccountConfig(section: MatrixChannelConfig | undefined): MatrixChannelAccountConfig {
  if (!section) {
    return {};
  }
  const {
    defaultAccount: _defaultAccount,
    accounts: _accounts,
    ...rest
  } = section;
  return rest;
}

export function listMatrixRustAccountIds(cfg: CoreConfig): string[] {
  const section = resolveMatrixSection(cfg);
  const ids = new Set<string>();
  const defaultConfig = extractDefaultAccountConfig(section);
  if (Object.keys(defaultConfig).length > 0 || section?.enabled !== undefined) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  for (const accountId of Object.keys(section?.accounts ?? {})) {
    ids.add(normalizeAccountId(accountId));
  }
  if (ids.size === 0) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  return Array.from(ids);
}

export function resolveDefaultMatrixRustAccountId(cfg: CoreConfig): string {
  const section = resolveMatrixSection(cfg);
  const configured = section?.defaultAccount?.trim();
  if (configured) {
    return normalizeAccountId(configured);
  }
  return DEFAULT_ACCOUNT_ID;
}

export function resolveMatrixRustAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const section = resolveMatrixSection(params.cfg);
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMatrixRustAccountId(params.cfg),
  );
  const base = extractDefaultAccountConfig(section);
  const scoped =
    accountId === DEFAULT_ACCOUNT_ID ? {} : (section?.accounts?.[accountId] ?? {});
  const config: MatrixChannelAccountConfig = {
    ...base,
    ...scoped,
    dm: {
      ...base.dm,
      ...scoped.dm,
    },
    actions: {
      ...base.actions,
      ...scoped.actions,
    },
    groups: {
      ...(base.groups ?? {}),
      ...(scoped.groups ?? {}),
    },
    rooms: {
      ...(base.rooms ?? {}),
      ...(scoped.rooms ?? {}),
    },
  };
  const password = config.password?.trim();
  const accessToken = config.accessToken?.trim();
  const configured = Boolean(config.homeserver?.trim() && config.userId?.trim() && (password || accessToken));
  return {
    accountId,
    name: config.name,
    enabled: config.enabled ?? true,
    configured,
    homeserver: config.homeserver,
    userId: config.userId,
    authMode: password ? "password" : accessToken ? "accessToken" : undefined,
    deviceName: config.deviceName,
    config,
  };
}
