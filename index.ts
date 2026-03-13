import type { OpenClawPluginApi } from "openclaw/plugin-sdk/matrix";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/matrix";
import { matrixRustPlugin } from "./src/channel.js";
import { setMatrixRustRuntime } from "./src/runtime.js";

const plugin = {
  id: "matrix-rust",
  name: "Matrix",
  description: "Matrix channel plugin backed by a Rust native core",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMatrixRustRuntime(api.runtime);
    api.registerChannel({ plugin: matrixRustPlugin });
  },
};

export default plugin;
