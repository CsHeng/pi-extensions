import { mkdirSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_KEYS = ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)"] as const;

/** Minimal process environment for synthetic child fixtures under an owning cleanup root. */
export function syntheticSubprocessEnv(fixtureRoot: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	const home = overrides.HOME ?? join(fixtureRoot, "home");
	const tmp = overrides.TMPDIR ?? join(fixtureRoot, "tmp");
	if (overrides.HOME === undefined) mkdirSync(home, { recursive: true });
	if (overrides.TMPDIR === undefined) mkdirSync(tmp, { recursive: true });
	const env: NodeJS.ProcessEnv = {};
	for (const key of RUNTIME_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.HOME = home;
	env.TMPDIR = tmp;
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}
