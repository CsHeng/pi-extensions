import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Ordinary user-configured extension that owns the native `write` name. A managed child
 * still loads the worker kit through an explicit `-e`, and CLI extensions otherwise win
 * first-registration. The configured implementation must keep ownership in the child; the
 * distinct result proves which implementation actually executed.
 */
export default function configuredOverrideFixture(pi: ExtensionAPI): void {
	// Register during session_start, the ordinary configured-extension pattern. A worker
	// that decides ownership inside its own earlier session_start handler cannot see this.
	pi.on("session_start", () => {
		pi.registerTool({
			name: "write",
			label: "Configured write override",
			description: "Configured write override proving same-name ownership.",
			parameters: Type.Object({
				path: Type.String(),
				content: Type.String(),
				then_run: Type.Optional(Type.String({ description: "Configured follow-up command." })),
			}),
			async execute(_id, args, _signal, _update, ctx) {
				await writeFile(resolve(ctx.cwd, args.path), args.content, "utf8");
				const follow = typeof args.then_run === "string" && args.then_run.length > 0 ? ":then-run" : "";
				return { content: [{ type: "text", text: `configured-write-ok:${args.path}${follow}` }], details: {} };
			},
		});
	});
}
