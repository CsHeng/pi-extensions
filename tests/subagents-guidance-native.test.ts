
import { before as ensureScopeBefore } from "node:test";
import { mkdir as ensureScopeMkdir } from "node:fs/promises";
ensureScopeBefore(async () => { await ensureScopeMkdir("/tmp/scope", { recursive: true }); await ensureScopeMkdir("/tmp/src", { recursive: true }); });
import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { runChild } from "../extensions/subagents/runner.ts";
import { getManagedRole, getRole } from "../extensions/subagents/roles.ts";
import type { EffectiveRoute } from "../extensions/subagents/contracts.ts";
import { syntheticSubprocessEnv } from "./fixtures/synthetic-subprocess-env.ts";

const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const provider = fileURLToPath(new URL("fixtures/subagents-native-session.ts", import.meta.url));
const guard = fileURLToPath(new URL("../extensions/subagents/child-capability-guard.ts", import.meta.url));
const workerGuard = fileURLToPath(new URL("../extensions/subagents/worker-tools.ts", import.meta.url));
const invocation = process.env.CSHENG_GUIDANCE_HOST_PI === "installed" ? { command: "pi", args: ["-e", provider] } : { command: process.execPath, args: [cli, "-e", provider] };
const route: EffectiveRoute = { provider: "subagent-fixture", model: "fixture", thinking: "off", source: "parent", candidateIndex: 0, executionProfileApplied: false, reasoningProfileApplied: false, profileFallbacks: [] };

test("native append selection merges with child roles and survives session continuation", { timeout: 30000 }, async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-native-append-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const source = join(base, "project"), child = join(base, "snapshot"), agentDir = join(base, "agent"), scratch = join(base, "scratch");
	await Promise.all([join(source, ".pi"), join(child, ".pi"), agentDir, scratch].map(path => mkdir(path, { recursive: true })));
	const globalMarker = "GLOBAL_APPEND_FIXTURE", snapshotMarker = "SNAPSHOT_APPEND_FIXTURE", sourceMarker = "SOURCE_ONLY_APPEND_FIXTURE", contextMarker = "AGENTS_CONTEXT_FIXTURE";
	await writeFile(join(source, ".pi", "APPEND_SYSTEM.md"), sourceMarker);
	await writeFile(join(child, "AGENTS.md"), contextMarker);
	for (const selection of ["none", "global", "project"]) {
		if (selection === "global") await writeFile(join(agentDir, "APPEND_SYSTEM.md"), globalMarker);
		if (selection === "project") await writeFile(join(child, ".pi", "APPEND_SYSTEM.md"), snapshotMarker);
		for (const roleName of ["explorer", "worker"] as const) {
			const worker = roleName === "worker";
			const role = worker ? getManagedRole(roleName) : getRole(roleName);
			const session = join(base, `${selection}-${roleName}.jsonl`);
			await (await open(session, "wx", 0o600)).close();
			const options: Parameters<typeof runChild>[0] = {
				task: { id: "append", role: roleName, objective: "append-fixture", access: [{ permission: "read", scope: ["/tmp/scope"] }], grants: [], inputs: [], dependsOn: [], verification: [], resourceLocks: [] },
				role, route, cwd: child, sourceRoot: source, inheritSkills: false,
				guardExtensionPath: worker ? workerGuard : guard,
				...(worker ? { managedWorkerScratch: scratch } : {}),
				capability: { version: 4, cwd: child, role: roleName, grants: [{ permission: worker ? "write" as const : "read" as const, path: child }], roots: [] },
				prompt: "append-fixture", approveProject: true, diagnosticSession: { path: session, ref: "append-fixture", async removeUnused() {} }, invocation,
				env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir, CSHENG_APPEND_EXPECT_PARTS: JSON.stringify([globalMarker, snapshotMarker, sourceMarker, role.systemPrompt, contextMarker]) }),
			};
			// A second episode restores the same native history without duplicating instructions.
			for (let episode = 0; episode < (selection === "project" ? 2 : 1); episode++) {
				const result = await runChild(options);
				assert.equal(result.status, "succeeded", `${selection}/${roleName}: ${result.error?.code} ${result.stderr}`);
				assert.deepEqual(JSON.parse(result.output), { counts: [Number(selection === "global"), Number(selection === "project"), 0, 1, 1], native: true });
			}
		}
	}
});

test("native blocked-tool hooks carry capability invalidation through the real stream", { timeout: 20000 }, async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-native-invalidated-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const child = join(base, "source"), agentDir = join(base, "agent"), root = join(base, "external.txt");
	await mkdir(child); await mkdir(agentDir); await writeFile(root, "original");
	const pin = await lstat(root);
	const session = join(base, "native.jsonl"); await (await open(session, "wx", 0o600)).close();
	const result = await runChild({
		task: { id: "invalidated", role: "explorer", objective: "host-explorer-fixture", access: [{ permission: "read", scope: ["/tmp/scope"] }], grants: [], inputs: [], dependsOn: [], verification: [], resourceLocks: [] },
		role: getRole("explorer"), route, cwd: child, sourceRoot: child, inheritSkills: false,
		guardExtensionPath: guard, capability: { version: 4, cwd: child, role: "explorer", grants: [{ permission: "read", path: child }, { permission: "read", path: root, pin: { dev: pin.dev, ino: pin.ino } }], roots: [] },
		prompt: "host-explorer-fixture capability-invalidated-fixture", approveProject: true,
		diagnosticSession: { path: session, ref: "fixture-invalidated", async removeUnused() {} }, invocation,
		env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir, CSHENG_NATIVE_REPLACE_ROOT: root }),
	});
	assert.equal(result.status, "failed", result.stderr);
	assert.equal(result.error?.code, "capability_invalidated", JSON.stringify(result));
	assert.equal(result.reportComplete, false);
	const entries = (await readFile(session, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.ok(entries.some(entry => entry.type === "custom" && entry.customType === "csheng-subagent-capability-failure" && entry.data?.code === "capability_invalidated"));
});

test("native child loads bounded Skill body/reference and snapshot ancestor context; role opt-out keeps context", { timeout: 20000 }, async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-native-guidance-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const source = join(base, "workspace", "project"); const child = join(base, "managed", "source"); const agentDir = join(base, "agent");
	const skill = join(agentDir, "skills", "guide");
	await Promise.all([source, child, join(skill, "references")].map(path => mkdir(path, { recursive: true })));
	await writeFile(join(base, "workspace", "AGENTS.md"), "ancestor context");
	await writeFile(join(source, "AGENTS.md"), "parent context");
	await writeFile(join(child, "AGENTS.override.md"), "snapshot override");
	await writeFile(join(base, "managed", "AGENTS.md"), "unrelated managed context");
	await writeFile(join(skill, "SKILL.md"), "---\nname: guide\ndescription: Use this guide for guidance-fixture.\n---\n# Guide\n");
	await writeFile(join(skill, "references", "rule.md"), "reference marker; export const answer = 42;");
	const guide = join(skill, "SKILL.md");
	for (const inheritSkills of [true, false]) {
		const session = join(base, `native-${inheritSkills}.jsonl`); await (await open(session, "wx", 0o600)).close();
		const result = await runChild({
			task: { id: "guidance", role: "explorer", objective: "guidance-fixture", access: [{ permission: "read", scope: ["/tmp/scope"] }], grants: [], inputs: [], dependsOn: [], verification: [], resourceLocks: [] },
			role: getRole("explorer"), route, cwd: child, sourceRoot: source, inheritSkills,
			guardExtensionPath: guard, capability: { version: 4, cwd: child, role: "explorer", grants: [{ permission: "read", path: child }], roots: [] },
			prompt: "guidance-fixture", approveProject: true, diagnosticSession: { path: session, ref: "fixture", async removeUnused() {} },
			invocation,
			env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir, CSHENG_GUIDANCE_EXPECT_PATH: guide }),
		});
		assert.equal(result.status, "succeeded", `${inheritSkills}: ${result.stderr} ${result.error?.code} ${result.output}`);
		assert.match(result.output, new RegExp(`catalog=${inheritSkills ? 1 : 0};ancestor=1;snapshot=1;managed=0;reads=${inheritSkills ? 2 : 0};reference=${inheritSkills ? 1 : 0}`));
	}
	const scratch = join(base, "scratch"); await mkdir(scratch);
	const session = join(base, "native-worker.jsonl"); await (await open(session, "wx", 0o600)).close();
	const worker = await runChild({
		task: { id: "candidate", role: "worker", objective: "guidance-worker-fixture", access: [{ permission: "write", scope: ["/tmp/write"] }], grants: [], inputs: [], dependsOn: [], verification: [], resourceLocks: [] },
		role: getManagedRole("worker"), route, cwd: child, sourceRoot: source, inheritSkills: true,
		guardExtensionPath: workerGuard, managedWorkerScratch: scratch,
		capability: { version: 4, cwd: child, role: "worker", grants: [{ permission: "write", path: child }], roots: [] },
		prompt: "guidance-worker-fixture", approveProject: true, diagnosticSession: { path: session, ref: "fixture-worker", async removeUnused() {} },
		invocation,
		env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir, CSHENG_GUIDANCE_EXPECT_PATH: guide }),
	});
	assert.equal(worker.status, "succeeded", `${worker.stderr} ${worker.error?.code} ${worker.output}`);
	assert.equal(worker.workerToolsSettled, true);
	assert.match(worker.output, /catalog=1;ancestor=1;snapshot=1;managed=0;reads=3;reference=1/);
	assert.equal(await readFile(join(child, "candidate.ts"), "utf8"), "export const answer = 42;\n");
});

test("effective parent catalog preserves project winner and excluded global Skill in native child", { timeout: 20000 }, async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-native-selection-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const source = join(base, "project"), child = join(base, "source"), agentDir = join(base, "agent");
	const project = join(source, ".agents", "skills", "guide"), captured = join(child, ".agents", "skills", "guide");
	const global = join(agentDir, "skills", "guide"), excluded = join(agentDir, "skills", "excluded");
	await Promise.all([project, captured, global, excluded].map(path => mkdir(join(path, "references"), { recursive: true })));
	for (const path of [project, captured, global, excluded]) {
		await writeFile(join(path, "SKILL.md"), `---\nname: ${path === excluded ? "excluded" : "guide"}\ndescription: Fixture catalog selection.\n---\n# Guide\n`);
		await writeFile(join(path, "references", "rule.md"), "reference marker");
	}
	const selected = loadSkills({ cwd: source, agentDir, includeDefaults: false, skillPaths: [project] }).skills;
	const parentSkills = selected.map(skill => ({ ...skill, sourceInfo: { ...skill.sourceInfo, scope: "project" as const } }));
	const session = join(base, "selected.jsonl"); await (await open(session, "wx", 0o600)).close();
	const result = await runChild({
		task: { id: "selected", role: "explorer", objective: "guidance-fixture", access: [{ permission: "read", scope: ["/tmp/scope"] }], grants: [], inputs: [], dependsOn: [], verification: [], resourceLocks: [] },
		role: getRole("explorer"), route, cwd: child, sourceRoot: source, inheritSkills: true, parentSkills,
		guardExtensionPath: guard, capability: { version: 4, cwd: child, role: "explorer", grants: [{ permission: "read", path: child }], roots: [] },
		prompt: "guidance-fixture", approveProject: true, diagnosticSession: { path: session, ref: "fixture-selection", async removeUnused() {} },
		invocation, env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir, CSHENG_GUIDANCE_EXPECT_PATH: join(captured, "SKILL.md"), CSHENG_GUIDANCE_FORBIDDEN_PATH: join(excluded, "SKILL.md") }),
	});
	assert.equal(result.status, "succeeded", `${result.error?.code}: ${result.stderr}`);
	assert.match(result.output, /catalog=1;ancestor=0;snapshot=0;managed=0;reads=2;reference=1;forbidden=0/);
});

test("an ordinary configured custom tool reaches an authorized native child; labels keep read-only intent", { timeout: 40000 }, async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-native-catalog-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const child = join(base, "source"), agentDir = join(base, "agent"), scratch = join(base, "scratch");
	await Promise.all([child, agentDir, scratch].map(path => mkdir(path, { recursive: true })));
	// An ordinary user-configured extension: it loads from settings, never from an explicit -e.
	const customTool = fileURLToPath(new URL("fixtures/subagents-custom-tool.ts", import.meta.url));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [customTool] }));
	for (const [roleName, write, guardPath] of [["explorer", false, guard], ["reviewer", false, guard], ["worker", true, workerGuard]] as const) {
		const session = join(base, `${roleName}.jsonl`); await (await open(session, "wx", 0o600)).close();
		const role = write ? getManagedRole(roleName) : getRole(roleName);
		const result = await runChild({
			task: { id: roleName, role: roleName, objective: "catalog-fixture", access: [{ permission: write ? "write" : "read", scope: ["/tmp/scope"] }], grants: [], inputs: [], dependsOn: [], verification: [], resourceLocks: [] },
			role, route, cwd: child, sourceRoot: child, inheritSkills: false,
			guardExtensionPath: guardPath,
			...(write ? { managedWorkerScratch: scratch } : {}),
			capability: { version: 4, cwd: child, role: roleName, grants: [{ permission: write ? "write" as const : "read" as const, path: child }], roots: [] },
			prompt: "catalog-child-fixture", approveProject: true,
			diagnosticSession: { path: session, ref: `catalog-${roleName}`, async removeUnused() {} }, invocation,
			env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir }),
		});
		assert.equal(result.status, "succeeded", `${roleName}: ${result.error?.code} ${result.stderr} ${result.output}`);
		// The configured custom tool ran for the child and stayed in the request catalog.
		assert.match(result.output, /probe=fixture_custom/);
		assert.match(result.output, /tools=[^;]*fixture_custom/);
		if (write) {
			assert.match(result.output, /tools=[^;]*\bedit\b/);
			assert.match(result.output, /tools=[^;]*\bwrite\b/);
			assert.equal(result.workerToolsSettled, true);
		} else {
			// Explicit read-only intent still removes the mutating builtins.
			assert.doesNotMatch(result.output, /tools=[^;]*\bedit\b/);
			assert.doesNotMatch(result.output, /tools=[^;]*\bwrite\b/);
		}
	}
	// The same configured catalog reaches a main actor: the custom tool is active and callable there too.
	const mainSession = join(base, "main.jsonl"); await (await open(mainSession, "wx", 0o600)).close();
	const mainPending = promisify(execFile)(invocation.command, [...invocation.args, "--mode", "json", "-p", "--session", mainSession, "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve", "--model", "subagent-fixture/fixture", "--thinking", "off", "--", "catalog-child-fixture"], {
		cwd: child, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
		env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir }),
	}) as Promise<{ stdout: string; stderr: string }> & { child: ChildProcess };
	mainPending.child.stdin?.end();
	const main = await mainPending;
	assert.match(main.stdout, /probe=fixture_custom/);
	assert.match(main.stdout, /tools=[^"]*fixture_custom/);
});

test("configured same-name native write override keeps ownership in a managed worker", { timeout: 40000 }, async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-native-override-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const child = join(base, "source"), agentDir = join(base, "agent"), scratch = join(base, "scratch");
	await Promise.all([child, agentDir, scratch].map(path => mkdir(path, { recursive: true })));
	// A configured extension owns `write`; the real source package is co-loaded to prove the
	// worker kit does not shadow either the configured override or the package tool.
	const override = fileURLToPath(new URL("fixtures/subagents-configured-override.ts", import.meta.url));
	const sourcePackage = fileURLToPath(new URL("fixtures/subagents-native-parent.ts", import.meta.url));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [override, sourcePackage] }));
	const session = join(base, "worker.jsonl"); await (await open(session, "wx", 0o600)).close();
	const result = await runChild({
		task: { id: "worker", role: "worker", objective: "configured-write-fixture", access: [{ permission: "write", scope: ["/tmp/write"] }], grants: [], inputs: [], dependsOn: [], verification: [], resourceLocks: [] },
		role: getManagedRole("worker"), route, cwd: child, sourceRoot: child, inheritSkills: false,
		guardExtensionPath: workerGuard, managedWorkerScratch: scratch,
		capability: { version: 4, cwd: child, role: "worker", grants: [{ permission: "write", path: child }], roots: [] },
		prompt: "configured-write-fixture", approveProject: true,
		diagnosticSession: { path: session, ref: "override-worker", async removeUnused() {} }, invocation,
		env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir }),
	});
	assert.equal(result.status, "succeeded", `${result.error?.code}: ${result.stderr} ${result.output}`);
	// The configured implementation ran, not the worker wrapper, and the co-loaded package tool stayed present.
	assert.match(result.output, /override=configured-write-ok:[^"]*candidate\.txt:then-run/);
	assert.match(result.output, /tools=[^;]*csheng_subagent_sessions/);
	assert.equal(result.workerToolsSettled, true);
	assert.equal(await readFile(join(child, "candidate.txt"), "utf8"), "configured");
	// Toolkit lifecycle evidence names only the tools this kit owns; `write` is opaque here.
	const lifecycle = (await readFile(session, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.customType === "csheng-worker-lifecycle");
	assert.ok(lifecycle.length >= 2, JSON.stringify(lifecycle));
	assert.ok(lifecycle.every(entry => Array.isArray(entry.data.owned) && !entry.data.owned.includes("write")), JSON.stringify(lifecycle));
	// The toolkit still owns every native name the configured catalog left to the builtins.
	for (const name of ["read", "grep", "find", "ls", "edit", "bash", "git_read"]) assert.ok(lifecycle[0]!.data.owned.includes(name), `${name} missing from owned: ${JSON.stringify(lifecycle[0]!.data.owned)}`);
	// Baseline: a main process without the worker kit resolves the same configured owner.
	const mainSession = join(base, "main.jsonl"); await (await open(mainSession, "wx", 0o600)).close();
	const mainPending = promisify(execFile)(invocation.command, [...invocation.args, "--mode", "json", "-p", "--session", mainSession, "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve", "--model", "subagent-fixture/fixture", "--thinking", "off", "--", "configured-write-fixture"], {
		cwd: child, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
		env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir }),
	}) as Promise<{ stdout: string; stderr: string }> & { child: ChildProcess };
	mainPending.child.stdin?.end();
	const main = await mainPending;
	assert.match(main.stdout, /override=configured-write-ok:[^"]*candidate\.txt:then-run/);
});

test("a real managed child cannot delegate outside its grants through the co-loaded typed tool", { timeout: 40000 }, async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-native-nested-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const child = join(base, "source"), agentDir = join(base, "agent"), scratch = join(base, "scratch"), outside = join(base, "outside");
	await Promise.all([child, agentDir, scratch, outside].map(path => mkdir(path, { recursive: true })));
	await promisify(execFile)("git", ["init", "-q", child]);
	// Co-loading the real source package makes the typed delegation tool reachable in the child.
	const sourcePackage = fileURLToPath(new URL("fixtures/subagents-native-parent.ts", import.meta.url));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [sourcePackage] }));
	const session = join(base, "worker.jsonl"); await (await open(session, "wx", 0o600)).close();
	const result = await runChild({
		task: { id: "worker", role: "worker", objective: "nested-delegation-fixture", access: [{ permission: "write", scope: ["/tmp/write"] }], grants: [], inputs: [], dependsOn: [], verification: [], resourceLocks: [] },
		role: getManagedRole("worker"), route, cwd: child, sourceRoot: child, inheritSkills: false,
		guardExtensionPath: workerGuard, managedWorkerScratch: scratch,
		capability: { version: 4, cwd: child, role: "worker", grants: [{ permission: "write", path: child }], roots: [] },
		prompt: "nested-delegation-fixture", approveProject: true,
		diagnosticSession: { path: session, ref: "nested-worker", async removeUnused() {} }, invocation,
		env: syntheticSubprocessEnv(base, { PI_CODING_AGENT_DIR: agentDir, CSHENG_NESTED_SCOPE: outside }),
	});
	assert.equal(result.status, "succeeded", `${result.error?.code}: ${result.stderr} ${result.output}`);
	assert.match(result.output, /nested=failed;code=nested_access_denied/);
});
