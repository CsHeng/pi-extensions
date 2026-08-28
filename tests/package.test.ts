import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PackageManifest {
	name?: string;
	private?: boolean;
	type?: string;
	pi?: { extensions?: string[] };
}

const ROOT = new URL("../", import.meta.url);

test("package exposes exactly one generic workflow harness extension", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("package.json", ROOT), "utf8"),
	) as PackageManifest;

	assert.equal(manifest.name, "@csheng/pi-extensions");
	assert.equal(manifest.private, true);
	assert.equal(manifest.type, "module");
	assert.deepEqual(manifest.pi?.extensions, [
		"./extensions/workflow-harness/index.ts",
	]);
});
