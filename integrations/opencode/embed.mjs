// Embeddable variant of the OpenCode plugin for corporate packaging:
// identical bundle to plugin.js but without export statements, so a
// deployment header/footer can be concatenated into one self-contained
// file. The core handle is attached to globalThis because an unused
// module-local constant would be tree-shaken by esbuild.
import { MetricsPlugin } from "./plugin.js";

globalThis.__agentRunMetricsCore = { MetricsPlugin };
