import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

test("package manifest has no managed subagent npm dependency", async () => {
	const manifest = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	assert.equal(manifest.dependencies?.[["pi", "subagents"].join("-")], undefined);
});
