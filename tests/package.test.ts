import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PackageManifest {
	name?: string;
	private?: boolean;
	type?: string;
	files?: string[];
	peerDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	pi?: { extensions?: string[] };
}

const ROOT = new URL("../", import.meta.url);

test("package exposes the three maintained extensions and their Pi peers", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("package.json", ROOT), "utf8"),
	) as PackageManifest;

	assert.equal(manifest.name, "@csheng/pi-extensions");
	assert.equal(manifest.private, true);
	assert.equal(manifest.type, "module");
	assert.deepEqual(manifest.files, ["config/", "extensions/"]);
	assert.deepEqual(manifest.pi?.extensions, [
		"./extensions/plan-mode/index.ts",
		"./extensions/multi-skill-mentions/index.ts",
		"./extensions/subagents/index.ts",
	]);
	assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependencies?.["@earendil-works/pi-tui"], "*");
	assert.equal(manifest.scripts?.["e2e:subagents"], "node --experimental-strip-types scripts/run-live-subagents-e2e.ts");
});
