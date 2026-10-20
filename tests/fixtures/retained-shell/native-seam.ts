import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalBashOperations, VERSION, type BashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Installed-host seam check for the retained-shell wrapper.
 *
 * It executes one command and one aborted command through the same exported
 * native operations the wrapper uses, then records the evidence. No model
 * request, network call, credential, or user agent state is involved.
 */
export default function nativeBashSeamProbe(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const dir = process.env.PI_CODING_AGENT_DIR;
		if (!dir) throw new Error("PI_CODING_AGENT_DIR is required");
		const proof: Record<string, unknown> = {
			version: VERSION,
			createLocalBashOperations: typeof createLocalBashOperations,
		};
		const operations: BashOperations = createLocalBashOperations();
		const chunks: string[] = [];
		const result = await operations.exec("printf 'native\\n'", process.cwd(), {
			onData: (data: Buffer) => { chunks.push(data.toString()); },
		});
		proof.exitCode = result.exitCode;
		proof.output = chunks.join("");
		const controller = new AbortController();
		const abortStartedAt = Date.now();
		const pending = operations.exec("sleep 10", process.cwd(), { onData: () => {}, signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		try {
			await pending;
			proof.aborted = false;
		} catch (error) {
			proof.aborted = true;
			proof.abortError = error instanceof Error ? error.message : String(error);
		}
		proof.abortMs = Date.now() - abortStartedAt;
		await writeFile(join(dir, "native-seam-proof.json"), JSON.stringify(proof));
	});
}
