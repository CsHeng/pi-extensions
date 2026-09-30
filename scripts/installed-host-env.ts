import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Keep Bun's injected checkout dependency bins from shadowing the installed CLI. */
export function installedHostEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const localBins = new Set<string>();
	for (let dir = resolve(fileURLToPath(new URL("../", import.meta.url))); ; dir = dirname(dir)) {
		localBins.add(join(dir, "node_modules", ".bin"));
		if (dirname(dir) === dir) break;
	}
	return { ...source, PATH: (source.PATH ?? "").split(delimiter).filter(path => !localBins.has(resolve(path))).join(delimiter) };
}
