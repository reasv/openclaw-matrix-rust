import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CoreConfig, MatrixChannelAccountConfig, MatrixInboundEvent } from "../types.js";
import { resolveMatrixSenderUsername } from "./inbound-format.js";

const DEFAULT_USER_PROFILE_ROOT_DIR = "users";

export async function buildMatrixUserProfileHint(params: {
  cfg: CoreConfig;
  accountConfig: MatrixChannelAccountConfig;
  event: Pick<MatrixInboundEvent, "senderId" | "senderName">;
}): Promise<string | undefined> {
  if (params.accountConfig.userProfiles?.enabled === false) {
    return undefined;
  }
  const workspaceRoot = resolveWorkspaceRoot(params.cfg);
  if (!workspaceRoot) {
    return undefined;
  }
  const rootDir = normalizeRootDir(params.accountConfig.userProfiles?.rootDir) ?? DEFAULT_USER_PROFILE_ROOT_DIR;
  const target = {
    provider: "matrix",
    senderId: params.event.senderId,
    username: resolveMatrixSenderUsername(params.event.senderId),
  };
  const resolved = await resolveMatrixUserProfilePath({
    workspaceRoot,
    rootDir,
    target,
  });

  const prefix = "[User profile]";
  if (resolved.exists) {
    return (
      `${prefix} A saved profile exists for this sender at ${resolved.workspacePath}. ` +
      `Use the dedicated user-profile tools if they are available; otherwise inspect or update that markdown file directly.`
    );
  }

  return (
    `${prefix} No saved profile exists yet for this sender. ` +
    `If you learn durable preferences or facts, save them after replying under ${resolved.workspacePath}.`
  );
}

export async function resolveMatrixUserProfilePath(params: {
  workspaceRoot: string;
  rootDir: string;
  target: {
    provider: string;
    senderId: string;
    username?: string;
  };
}): Promise<{ absolutePath: string; workspacePath: string; exists: boolean }> {
  const canonicalWorkspacePath = buildMatrixCanonicalUserProfileWorkspacePath({
    rootDir: params.rootDir,
    target: params.target,
  });
  const canonicalAbsolutePath = path.resolve(params.workspaceRoot, canonicalWorkspacePath);
  if (await pathExists(canonicalAbsolutePath)) {
    return {
      absolutePath: canonicalAbsolutePath,
      workspacePath: toWorkspaceRelativePath(params.workspaceRoot, canonicalAbsolutePath),
      exists: true,
    };
  }

  const legacyWorkspacePath = buildLegacyMatrixWorkspacePath(params.rootDir, params.target.senderId);
  if (legacyWorkspacePath) {
    const legacyAbsolutePath = path.resolve(params.workspaceRoot, legacyWorkspacePath);
    if (await pathExists(legacyAbsolutePath)) {
      return {
        absolutePath: legacyAbsolutePath,
        workspacePath: toWorkspaceRelativePath(params.workspaceRoot, legacyAbsolutePath),
        exists: true,
      };
    }
  }

  return {
    absolutePath: canonicalAbsolutePath,
    workspacePath: toWorkspaceRelativePath(params.workspaceRoot, canonicalAbsolutePath),
    exists: false,
  };
}

function buildMatrixCanonicalUserProfileWorkspacePath(params: {
  rootDir: string;
  target: {
    provider: string;
    senderId: string;
    username?: string;
  };
}): string {
  const username = params.target.username?.trim() || "user";
  const slug = username
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "user";
  const hash = createHash("sha256")
    .update(`${params.target.provider}\u0000${params.target.senderId}`)
    .digest("hex")
    .slice(0, 8);
  return normalizePortablePath(`${params.rootDir}/matrix/${slug}--${hash}.md`);
}

function buildLegacyMatrixWorkspacePath(rootDir: string, senderId: string): string | undefined {
  const match = senderId.match(/^@([^:]+):(.+)$/);
  if (!match) {
    return undefined;
  }
  return normalizePortablePath(`${rootDir}/${match[1]}__${match[2]}.md`);
}

function resolveWorkspaceRoot(cfg: CoreConfig): string | undefined {
  const root =
    cfg &&
    typeof cfg === "object" &&
    !Array.isArray(cfg) &&
    typeof (cfg as { agents?: { defaults?: { workspace?: unknown } } }).agents?.defaults?.workspace === "string"
      ? ((cfg as { agents: { defaults: { workspace: string } } }).agents.defaults.workspace as string)
      : undefined;
  return root ? path.resolve(root) : undefined;
}

function normalizeRootDir(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizePortablePath(value);
}

function normalizePortablePath(rawPath: string): string {
  const portable = rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!portable || portable === "." || portable === ".." || portable.startsWith("/") || portable.includes("../")) {
    throw new Error("Matrix user profile paths must stay inside the workspace.");
  }
  return portable.replace(/\/+$/, "");
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../")) {
    throw new Error("Resolved matrix user profile path escapes the workspace.");
  }
  return `./${relative}`;
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}
