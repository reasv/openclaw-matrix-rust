import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMatrixUserProfileHint, resolveMatrixUserProfilePath } from "./user-profiles.js";

test("resolveMatrixUserProfilePath resolves canonical matrix paths", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-rust-user-profiles-"));
  const resolved = await resolveMatrixUserProfilePath({
    workspaceRoot,
    rootDir: "users",
    target: {
      provider: "matrix",
      senderId: "@alice:example.org",
      username: "alice",
    },
  });

  assert.equal(resolved.exists, false);
  assert.match(resolved.workspacePath, /^\.\/users\/matrix\/alice--[a-f0-9]{8}\.md$/);
});

test("resolveMatrixUserProfilePath finds legacy matrix paths", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-rust-user-profiles-"));
  await fs.mkdir(path.join(workspaceRoot, "users"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "users", "alice__example.org.md"), "# Summary\n\nlegacy\n");

  const resolved = await resolveMatrixUserProfilePath({
    workspaceRoot,
    rootDir: "users",
    target: {
      provider: "matrix",
      senderId: "@alice:example.org",
      username: "alice",
    },
  });

  assert.equal(resolved.exists, true);
  assert.equal(resolved.workspacePath, "./users/alice__example.org.md");
});

test("buildMatrixUserProfileHint reports availability and disablement", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-rust-user-profiles-"));
  const hintMissing = await buildMatrixUserProfileHint({
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceRoot,
        },
      },
    } as any,
    accountConfig: {},
    event: {
      senderId: "@alice:example.org",
      senderName: "Alice",
    },
  });

  assert.equal(hintMissing, "[User profile] None yet for this sender.");

  const hintDisabled = await buildMatrixUserProfileHint({
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceRoot,
        },
      },
    } as any,
    accountConfig: {
      userProfiles: {
        enabled: false,
      },
    },
    event: {
      senderId: "@alice:example.org",
      senderName: "Alice",
    },
  });

  assert.equal(hintDisabled, undefined);

  const resolved = await resolveMatrixUserProfilePath({
    workspaceRoot,
    rootDir: "users",
    target: {
      provider: "matrix",
      senderId: "@alice:example.org",
      username: "alice",
    },
  });
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(resolved.absolutePath, "# Summary\n\nsaved\n");

  const hintPresent = await buildMatrixUserProfileHint({
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceRoot,
        },
      },
    } as any,
    accountConfig: {},
    event: {
      senderId: "@alice:example.org",
      senderName: "Alice",
    },
  });

  assert.equal(hintPresent, "[User profile] Available for this sender.");
});
