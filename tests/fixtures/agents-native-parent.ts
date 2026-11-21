import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentsExtension } from "../../extensions/agents/index.ts";
import { defaultConfig } from "../../extensions/agents/config.ts";
import { runChild } from "../../extensions/agents/runner.ts";

export default function nativeParentFixture(pi: ExtensionAPI): void {
	createAgentsExtension({
		loadConfig: async () => ({ config: defaultConfig() }),
		runChild: (options) => runChild({ ...options, invocation: process.env.PI_EXTENSIONS_NATIVE_INSTALLED === "1"
			? { command: "pi", args: ["-e", new URL("./agents-native-session.ts", import.meta.url).pathname, "--no-context-files"] }
			: { command: process.execPath, args: [new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname, "-e", new URL("./agents-native-session.ts", import.meta.url).pathname, "--no-context-files"] },
		}),
	})(pi);
}
