import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import test from "node:test";

const ROOT = new URL("../", import.meta.url).pathname;
const EXCLUDED = new Set([".git", "node_modules", ".dist", "coverage", "plans"]);
const TEXT_EXTENSIONS = new Set([".json", ".md", ".sh", ".ts"]);
const FORBIDDEN = [
	["agent", "skills"].join("-"),
	["design", "change"].join("-"),
	["plan", "change"].join("-"),
	["implement", "change"].join("-"),
	["review", "change"].join("-"),
	["coding", "Harness"].join(""),
	["src", "runtime", "harness"].join("/"),
	["integrations", "pi"].join("/"),
] as const;

async function maintainedTextFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (EXCLUDED.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await maintainedTextFiles(path)));
		else if (TEXT_EXTENSIONS.has(extname(entry.name))) files.push(path);
	}
	return files;
}

test("maintained package has no collection-specific dependency", async () => {
	const violations: string[] = [];
	for (const path of await maintainedTextFiles(ROOT)) {
		const text = await readFile(path, "utf8");
		for (const token of FORBIDDEN) {
			if (text.includes(token)) violations.push(`${relative(ROOT, path)}: ${token}`);
		}
	}
	assert.deepEqual(violations, []);
});
