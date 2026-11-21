import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRoleDefinitions, parseRoleDefinition } from "../extensions/agents/role-definitions.ts";

function markdown(name: string, extra = "", body = "Use the assigned tools."): string {
	return `---\nname: ${name}\ndescription: Investigate the inputs.\n${extra}---\n\n${body}\n`;
}

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-extensions-agents-roles-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "user");
	const projectRoot = join(root, "project");
	const user = join(agentDir, "agent-roles");
	const project = join(projectRoot, ".pi", "agent-roles");
	await Promise.all([mkdir(user, { recursive: true }), mkdir(project, { recursive: true })]);
	return { agentDir, projectRoot, user, project };
}

test("role frontmatter and the Markdown body are parsed separately", () => {
	const explicit = markdown("code-reader", "workspace: isolated\nfallbackRoute: explorer\nmay:\n  message: [assigner, peers, draft-author]\n  roster: true\n  invoke: false\n", "# Investigate\n\nReturn evidence.");
	assert.deepEqual(parseRoleDefinition(explicit.replaceAll("\n", "\r\n"), "project", "/project/.pi/agent-roles/code-reader.md"), {
		name: "code-reader",
		description: "Investigate the inputs.",
		systemPrompt: "# Investigate\n\nReturn evidence.",
		source: "project",
		workspace: "isolated",
		may: { message: ["assigner", "peers", "draft-author"], roster: true, invoke: false },
		fallbackRoute: "explorer",
	});
	const minimal = parseRoleDefinition(markdown("code-reader"), "user", "code-reader.md");
	assert.equal(minimal.workspace, "shared");
	assert.deepEqual(minimal.may, { message: [], roster: false, invoke: false });
	assert.equal(minimal.fallbackRoute, undefined);
});

test("role frontmatter rejects malformed definitions without including YAML source text", () => {
	const valid = markdown("code-reader");
	for (const [text, reason] of [
		[markdown("Code-reader"), /invalid role name/],
		[markdown("a".repeat(33)), /invalid role name/],
		[markdown("other-name"), /match the filename/],
		[markdown("code-reader", "access: write\n"), /frontmatter contains an unsupported field/],
		[markdown("code-reader", "workspace: copy\n"), /workspace/],
		[markdown("code-reader", "fallbackRoute: '$parent'\n"), /fallbackRoute/],
		[markdown("code-reader", "may: true\n"), /may must be a mapping/],
		[markdown("code-reader", "may: {unknown: true}\n"), /may contains an unsupported field/],
		[markdown("code-reader", "may: {message: peers}\n"), /may\.message/],
		[markdown("code-reader", "may: {message: [assigner, true]}\n"), /may\.message/],
		[markdown("code-reader", "may: {message: ['*']}\n"), /may\.message/],
		[markdown("code-reader", "may: {roster: 1, invoke: true}\n"), /must be booleans/],
		[markdown("code-reader", "may: {invoke: 'false'}\n"), /must be booleans/],
		[valid.replace("Investigate the inputs.", "42"), /description/],
		[markdown("code-reader", "", ""), /system prompt/],
		[markdown("code-reader", "may: [must-not-appear\n"), /^Error: invalid role frontmatter YAML$/],
	] as const) {
		assert.throws(() => parseRoleDefinition(text, "user", "code-reader.md"), reason);
	}
});

test("trusted project roles override user roles, and valid user roles override package roles", async t => {
	const dirs = await fixture(t);
	await Promise.all([
		writeFile(join(dirs.user, "explorer.md"), markdown("explorer", "", "User explorer.")),
		writeFile(join(dirs.user, "custom.md"), markdown("custom", "", "User custom role.")),
		writeFile(join(dirs.project, "explorer.md"), markdown("explorer", "", "Project explorer.")),
		writeFile(join(dirs.project, "reviewer.md"), markdown("wrong-name")),
		writeFile(join(dirs.project, "project-only.md"), markdown("project-only")),
	]);
	const untrusted = await loadRoleDefinitions({ ...dirs, trusted: false });
	assert.equal(untrusted.roles.get("explorer")?.systemPrompt, "User explorer.");
	assert.equal(untrusted.roles.get("explorer")?.source, "user");
	assert.equal(untrusted.roles.has("project-only"), false);
	assert.deepEqual(untrusted.problems, []);

	const trusted = await loadRoleDefinitions({ ...dirs, trusted: true });
	assert.equal(trusted.roles.get("explorer")?.systemPrompt, "Project explorer.");
	assert.equal(trusted.roles.get("explorer")?.source, "project");
	assert.equal(trusted.roles.get("custom")?.source, "user");
	assert.equal(trusted.roles.get("project-only")?.source, "project");
	assert.deepEqual(trusted.problems, [{ file: join(dirs.project, "reviewer.md"), reason: "role name must match the filename" }]);
	for (const name of ["reviewer", "worker"]) {
		const role = trusted.roles.get(name);
		assert.equal(role?.source, "package");
		assert.equal(role.workspace, "shared");
		assert.deepEqual(role.may, { message: ["assigner", "peers"], roster: true, invoke: true });
	}
});

test("role files are byte-bounded and only regular non-symlink Markdown files load", async t => {
	const dirs = await fixture(t);
	const limit = 64 * 1024;
	const bytes = limit - Buffer.byteLength(markdown("exact", "", ""));
	const exact = markdown("exact", "", "a".repeat(bytes));
	assert.equal(Buffer.byteLength(exact), limit);
	await Promise.all([
		writeFile(join(dirs.user, "exact.md"), exact),
		writeFile(join(dirs.user, "large.md"), markdown("large", "", "é".repeat(limit / 2))),
		writeFile(join(dirs.user, "ignore.txt"), markdown("ignore")),
		mkdir(join(dirs.user, "folder.md")),
	]);
	await symlink(join(dirs.user, "exact.md"), join(dirs.user, "linked.md"));
	const result = await loadRoleDefinitions({ ...dirs, trusted: true });
	assert.equal(result.roles.get("exact")?.systemPrompt.length, bytes);
	assert.equal(result.roles.has("ignore"), false);
	assert.equal(result.roles.has("large"), false);
	assert.equal(result.roles.has("linked"), false);
	assert.equal(result.roles.has("folder"), false);
	assert.deepEqual(new Map(result.problems.map(({ file, reason }) => [file, reason])), new Map([
		[join(dirs.user, "large.md"), "role file exceeds 64 KiB"],
		[join(dirs.user, "linked.md"), "role file must be a regular non-symlink file"],
		[join(dirs.user, "folder.md"), "role file must be a regular non-symlink file"],
	]));
});

test("the 64-file bound applies separately per source", async t => {
	const dirs = await fixture(t);
	await Promise.all(Array.from({ length: 65 }, (_, index) => {
		const name = `role-${index}`;
		return writeFile(join(dirs.user, `${name}.md`), markdown(name));
	}));
	await writeFile(join(dirs.project, "project-only.md"), markdown("project-only"));
	const result = await loadRoleDefinitions({ ...dirs, trusted: true });
	assert.equal([...result.roles.values()].filter(role => role.source === "user").length, 64);
	assert.equal(result.roles.get("project-only")?.source, "project");
	assert.deepEqual(result.problems, [{ file: dirs.user, reason: "role source exceeds 64 Markdown entries" }]);
});
