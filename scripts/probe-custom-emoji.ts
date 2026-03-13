import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { resolveNativeConfig } from "../src/matrix/adapter/config.js";
import { resolveDefaultMatrixRustAccountId, resolveMatrixRustAccount } from "../src/matrix/accounts.js";
import type {
  CoreConfig,
  MatrixListEmojiRequest,
  MatrixNativeConfig,
  MatrixNativeDiagnostics,
  MatrixNativeEvent,
} from "../src/types.js";

type NativeBindingClient = {
  start(configJson: string): string;
  stop(): void;
  pollEvents(): string;
  listKnownShortcodes(requestJson: string): string;
};

function loadConfig(configPath: string): CoreConfig {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as CoreConfig;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBindingPath(): string {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`probe currently supports linux-x64 only; got ${process.platform}-${process.arch}`);
  }
  return path.resolve(process.cwd(), "npm/index.linux-x64-gnu.node");
}

class ProbeClient {
  readonly #client: NativeBindingClient;

  constructor() {
    const require = createRequire(import.meta.url);
    const bindingPath = resolveBindingPath();
    this.#client = new (require(bindingPath).MatrixCoreClient as new () => NativeBindingClient)();
  }

  start(config: MatrixNativeConfig): MatrixNativeDiagnostics {
    return JSON.parse(this.#client.start(JSON.stringify(config))) as MatrixNativeDiagnostics;
  }

  stop(): void {
    this.#client.stop();
  }

  pollEvents(): MatrixNativeEvent[] {
    return JSON.parse(this.#client.pollEvents()) as MatrixNativeEvent[];
  }

  listKnownShortcodes(request: MatrixListEmojiRequest = {}): string[] {
    return JSON.parse(this.#client.listKnownShortcodes(JSON.stringify(request))) as string[];
  }
}

async function main(): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.resolve(process.cwd(), "../openclaw.json");
  const cfg = loadConfig(configPath);
  const accountId = process.argv[2]?.trim() || resolveDefaultMatrixRustAccountId(cfg);
  const account = resolveMatrixRustAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Matrix account ${account.accountId} is not configured`);
  }

  const stateRoot = process.env.OPENCLAW_STATE_DIR ?? path.resolve(path.dirname(configPath), ".openclaw");
  const nativeConfig = resolveNativeConfig({
    account,
    runtime: {
      state: {
        resolveStateDir: () => stateRoot,
      },
    } as any,
  });
  const client = new ProbeClient();

  console.log(`config: ${configPath}`);
  console.log(`state: ${nativeConfig.stateLayout.rootDir}`);
  console.log(`account: ${account.accountId} (${account.userId})`);

  const diagnostics = client.start(nativeConfig);
  console.log(`started: sync=${diagnostics.syncState} user=${diagnostics.userId} device=${diagnostics.deviceId}`);

  const catalogPath = nativeConfig.stateLayout.emojiCatalogFile;
  let lastCatalogMtime = fs.existsSync(catalogPath) ? fs.statSync(catalogPath).mtimeMs : 0;

  try {
    for (;;) {
      for (const event of client.pollEvents()) {
        if (event.type === "sync_state") {
          console.log(`sync_state=${event.state}`);
          continue;
        }
        if (event.type === "lifecycle") {
          console.log(`${event.stage}: ${event.detail}`);
          continue;
        }
        if (event.type === "inbound") {
          const formatted = event.event.formattedBody?.includes("data-mx-emoticon") ? " emoji-html" : "";
          console.log(
            `inbound ${event.event.roomId} ${event.event.eventId}${formatted} body=${JSON.stringify(event.event.body)}`,
          );
        }
      }

      const shortcodes = client.listKnownShortcodes({});
      const catalogExists = fs.existsSync(catalogPath);
      const nextCatalogMtime = catalogExists ? fs.statSync(catalogPath).mtimeMs : 0;
      if (nextCatalogMtime !== lastCatalogMtime) {
        lastCatalogMtime = nextCatalogMtime;
        console.log(`catalog updated: ${catalogPath}`);
        console.log(JSON.stringify(shortcodes));
        if (catalogExists) {
          console.log(fs.readFileSync(catalogPath, "utf8"));
        }
      }

      await sleep(1000);
    }
  } finally {
    client.stop();
  }
}

main().catch((error: unknown) => {
  console.error(String(error));
  process.exitCode = 1;
});
