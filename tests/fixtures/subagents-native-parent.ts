import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentsExtension } from "../../extensions/agents/index.ts";
import { defaultConfig } from "../../extensions/agents/config.ts";
import { runChild } from "../../extensions/agents/runner.ts";

/** The real parent registration and subprocess bridge, with only synthetic models. */
export default function nativeParentFixture(pi: ExtensionAPI): void {
	createSubagentsExtension({
		loadConfig: async () => ({ config: defaultConfig() }),
		runChild: (options) => runChild({ ...options, invocation: process.env.CSHENG_NATIVE_INSTALLED === "1"
			? { command: "pi", args: ["-e", new URL("./subagents-native-session.ts", import.meta.url).pathname, "--no-context-files"] }
			: { command: process.execPath, args: [new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname, "-e", new URL("./subagents-native-session.ts", import.meta.url).pathname, "--no-context-files"] },
		}),
	})(pi);
}
