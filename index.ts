import type { OpenClawPluginApi } from "openclaw/plugin-sdk/matrix";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/matrix";
import { matrixRustPlugin } from "./src/channel.js";
import {
  clearPendingMatrixUserProfileHints,
  setMatrixRustRuntime,
  takePendingMatrixUserProfileHint,
} from "./src/runtime.js";

const plugin = {
  id: "matrix-rust",
  name: "Matrix",
  description: "Matrix channel plugin backed by a Rust native core",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMatrixRustRuntime(api.runtime);
    api.registerChannel({ plugin: matrixRustPlugin });
    (api as OpenClawPluginApi & {
      on?: (
        hookName: "before_prompt_build" | "agent_end" | "before_reset",
        handler: (...args: any[]) => any,
      ) => void;
    }).on?.("before_prompt_build", async (_event, ctx) => {
      const hint = takePendingMatrixUserProfileHint(ctx.sessionKey);
      if (!hint || ctx.messageProvider !== "matrix") {
        return;
      }
      return {
        prependContext: `${hint}\n`,
      };
    });
    (api as OpenClawPluginApi & {
      on?: (
        hookName: "agent_end" | "before_reset",
        handler: (...args: any[]) => any,
      ) => void;
    }).on?.(["agent_end", "before_reset"] as any, () => {
      clearPendingMatrixUserProfileHints();
    });
  },
};

export default plugin;
