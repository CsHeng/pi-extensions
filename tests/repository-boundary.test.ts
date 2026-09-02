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
const HERDR_RUNTIME_FORBIDDEN = [
	"extensions/subagents",
	["from", "./subagents"].join(" "),
	["net", "connect"].join("."),
	["integrations", "pi"].join("/"),
	["agent", "skills"].join("-"),
] as const;
const SUBAGENT_RUNTIME_FORBIDDEN = [
	["pi", "subagents"].join("-"),
	["workflow", "harness"].join("-"),
	"discoverAgents",
	"submit_task_graph",
] as const;
const CONCRETE_PROVIDER_MODEL = /\b(?:gpt-\d|claude-(?:\d|opus|sonnet|haiku)|gemini-(?:\d|pro|flash))/i;

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

test("subagent runtime has fixed roles and provider-neutral authored defaults", async () => {
	const runtimeRoot = join(ROOT, "extensions", "subagents");
	const violations: string[] = [];
	for (const path of await maintainedTextFiles(runtimeRoot)) {
		const text = await readFile(path, "utf8");
		for (const token of SUBAGENT_RUNTIME_FORBIDDEN) {
			if (text.includes(token)) violations.push(`${relative(ROOT, path)}: ${token}`);
		}
		if (CONCRETE_PROVIDER_MODEL.test(text)) violations.push(`${relative(ROOT, path)}: concrete-provider-model`);
	}
	const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
	assert.equal(manifest.dependencies?.[["pi", "subagents"].join("-")], undefined);
	assert.deepEqual(violations, []);
});

test("herdr-handoff runtime stays independent of subagents, sockets, and Herdr internals", async () => {
	const runtimeRoot = join(ROOT, "extensions", "herdr-handoff");
	const violations: string[] = [];
	for (const path of await maintainedTextFiles(runtimeRoot)) {
		const text = await readFile(path, "utf8");
		for (const token of HERDR_RUNTIME_FORBIDDEN) {
			if (text.includes(token)) violations.push(`${relative(ROOT, path)}: ${token}`);
		}
	}
	const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
	assert.equal(manifest.dependencies?.herdr, undefined);
	assert.deepEqual(violations, []);
});
