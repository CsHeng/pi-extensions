import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Ordinary user-configured extension tool. It is loaded from the disposable agent
 * directory's settings, never passed as an explicit `-e` argument, so its presence
 * proves the configured catalog reaches the actor.
 */
export default function customToolFixture(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fixture_custom",
		label: "Fixture custom",
		description: "Return a fixed marker; presence proves the configured catalog reached the actor.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "fixture-custom-ok" }], details: {} };
		},
	});
}
