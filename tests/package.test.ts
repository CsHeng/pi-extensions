import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PackageManifest {
	name?: string;
	private?: boolean;
	type?: string;
	files?: string[];
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	pi?: { extensions?: string[] };
}

const ROOT = new URL("../", import.meta.url);

test("package exposes the eight maintained extensions and their Pi peers", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("package.json", ROOT), "utf8"),
	) as PackageManifest;

	assert.equal(manifest.name, "@csheng/pi-extensions");
	assert.equal(manifest.private, true);
	assert.equal(manifest.type, "module");
	assert.deepEqual(manifest.files, ["config/", "extensions/"]);
	assert.deepEqual(manifest.pi?.extensions, [
		"./extensions/multi-skill-mentions/index.ts",
		"./extensions/fast-gpt/index.ts",
		"./extensions/subagents/index.ts",
		"./extensions/herdr-handoff/index.ts",
		"./extensions/status-footer/index.ts",
		"./extensions/work-timing/index.ts",
		"./extensions/subagents-ui/index.ts",
		"./extensions/workflow/index.ts",
	]);
	assert.deepEqual(manifest.peerDependencies, {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
		typebox: "*",
	});
	assert.equal(manifest.devDependencies?.["@earendil-works/pi-ai"], "0.86.0");
	assert.equal(manifest.devDependencies?.["@earendil-works/pi-coding-agent"], "0.86.0");
	assert.equal(manifest.devDependencies?.["@earendil-works/pi-tui"], "0.86.0");
	assert.equal(manifest.devDependencies?.typebox, "1.3.7");
	assert.equal(manifest.dependencies, undefined);
	assert.equal(manifest.scripts?.["e2e:subagents"], "node --experimental-strip-types scripts/run-live-subagents-e2e.ts");
});
