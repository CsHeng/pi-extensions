import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareChildGuidance } from "../extensions/subagents/guidance-resources.ts";
import { authorizePath } from "../extensions/subagents/path-policy.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "subagent-guidance-")); roots.push(root);
	const agentDir = join(root, "agent");
	const original = join(root, "workspace", "project");
	const child = join(root, "managed", "source");
	await Promise.all([agentDir, original, child, join(original, ".agents", "skills"), join(child, ".agents", "skills")].map(path => mkdir(path, { recursive: true })));
	await writeFile(join(agentDir, "AGENTS.md"), "global context");
	await writeFile(join(root, "workspace", "AGENTS.md"), "ancestor context");
	await writeFile(join(original, "AGENTS.md"), "parent repo context");
	await writeFile(join(child, "AGENTS.override.md"), "snapshot override");
	await writeFile(join(root, "managed", "AGENTS.md"), "unrelated managed context");
	for (const [base, name] of [[agentDir, "global-guide"], [original, "project-guide"], [child, "project-guide"]] as const) {
		const skill = base === agentDir ? join(base, "skills", name) : join(base, ".agents", "skills", name);
		await mkdir(join(skill, "references"), { recursive: true });
		await writeFile(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: Use ${name} for a test.\n---\n# ${name}\n`);
		await writeFile(join(skill, "references", "rule.md"), `reference ${base}`);
	}
	const installed = join(root, "installed-guide");
	await mkdir(installed); await writeFile(join(installed, "SKILL.md"), "---\nname: installed-guide\ndescription: Installed guidance.\n---\n# installed\n");
	await symlink(installed, join(agentDir, "skills", "installed-guide"));
	return { root, agentDir, original, child, installed };
}

describe("child native guidance bridge", () => {
	it("inherits native catalog and original ancestors while snapshot context wins", async () => {
		const { agentDir, original, child, installed } = await fixture();
		const guidance = await prepareChildGuidance(original, child, true, agentDir);
		assert.deepEqual(guidance.contextFiles.map(file => file.content), ["global context", "ancestor context", "snapshot override"]);
		assert.ok(guidance.skillPaths.includes(join(child, ".agents", "skills", "project-guide")));
		assert.ok(!guidance.skillPaths.includes(join(original, ".agents", "skills", "project-guide")));
		assert.ok(guidance.skillPaths.includes(join(agentDir, "skills", "global-guide")));
		assert.ok(guidance.skillPaths.includes(installed));
		assert.ok(!guidance.skillPaths.includes(join(agentDir, "skills", "installed-guide")));
		assert.match(await readFile(join(installed, "SKILL.md"), "utf8"), /installed/);
		assert.ok(!guidance.readRoots.includes(join(original, ".agents")));
	});
	it("snapshot membership survives a mutable parent Skill and missing package never provisions", async () => {
		const { agentDir, original, child } = await fixture();
		await writeFile(join(original, ".agents", "skills", "project-guide", "SKILL.md"), "invalid parent resource");
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:nonexistent-guidance-package-123456@1.0.0"] }));
		const guidance = await prepareChildGuidance(original, child, true, agentDir, join(agentDir, "empty-home"));
		assert.ok(guidance.skillPaths.includes(join(child, ".agents", "skills", "project-guide")));
		assert.ok(!guidance.skillPaths.includes(join(original, ".agents", "skills", "project-guide")));
		assert.ok(!existsSync(join(agentDir, "install")));
	});
	it("a Skill directory named .md never grants its parent siblings", async () => {
		const { agentDir, original, child } = await fixture();
		const namedMd = join(agentDir, "skills", "directory.md");
		await mkdir(namedMd);
		await writeFile(join(namedMd, "SKILL.md"), "---\nname: directory-md\ndescription: Directory named md.\n---\n# Directory\n");
		await writeFile(join(agentDir, "sibling-secret"), "private");
		const guidance = await prepareChildGuidance(original, child, true, agentDir, join(agentDir, "empty-home"));
		assert.ok(guidance.skillPaths.includes(namedMd));
		const manifest = { version: 2 as const, root: child, role: "explorer" as const, readRoots: [child], writePaths: [], externalReadRoots: [],
			guidance: { contextFiles: guidance.contextFiles, readRoots: guidance.readRoots, physicalRoots: guidance.physicalRoots } };
		assert.equal((await authorizePath(manifest, "read", join(namedMd, "SKILL.md"))).allowed, true);
		assert.equal((await authorizePath(manifest, "read", join(agentDir, "sibling-secret"))).allowed, false);
	});
	it("native file-form Skill grants its adjacent references without a write grant", async () => {
		const { agentDir, original, child } = await fixture();
		await writeFile(join(agentDir, "skills", "standalone.md"), "---\nname: standalone\ndescription: Standalone test guidance.\n---\n# Standalone\n");
		await writeFile(join(agentDir, "skills", "adjacent.txt"), "adjacent reference");
		const guidance = await prepareChildGuidance(original, child, true, agentDir, join(agentDir, "empty-home"));
		assert.ok(guidance.skillPaths.includes(join(agentDir, "skills", "standalone.md")));
		const manifest = { version: 2 as const, root: child, role: "worker" as const, readRoots: [child], writePaths: [], externalReadRoots: [], writeRoot: true as const,
			guidance: { contextFiles: guidance.contextFiles, readRoots: guidance.readRoots, physicalRoots: guidance.physicalRoots } };
		assert.equal((await authorizePath(manifest, "read", join(agentDir, "skills", "adjacent.txt"))).allowed, true);
		assert.equal((await authorizePath(manifest, "write", join(agentDir, "skills", "adjacent.txt"))).allowed, false);
	});
	it("never falls back to a tracked parent Skill absent from the captured input", async () => {
		const { agentDir, original, child } = await fixture();
		await promisify(execFile)("git", ["init", "-q", original]);
		await promisify(execFile)("git", ["-C", original, "add", "--", ".agents/skills/project-guide/SKILL.md"]);
		await rm(join(child, ".agents", "skills", "project-guide"), { recursive: true });
		const guidance = await prepareChildGuidance(original, child, true, agentDir);
		assert.ok(!guidance.skillPaths.includes(join(original, ".agents", "skills", "project-guide")));
	});
	it("an explicitly empty effective parent catalog does not rediscover excluded defaults", async () => {
		const { agentDir, original, child } = await fixture();
		const guidance = await prepareChildGuidance(original, child, true, agentDir, join(agentDir, "empty-home"), []);
		assert.deepEqual(guidance.skillPaths, []);
		assert.deepEqual(guidance.contextFiles.map(file => file.content), ["global context", "ancestor context", "snapshot override"]);
	});
	it("opt-out only disables catalog, not context", async () => {
		const { agentDir, original, child } = await fixture();
		const guidance = await prepareChildGuidance(original, child, false, agentDir);
		assert.deepEqual(guidance.skillPaths, []);
		assert.deepEqual(guidance.contextFiles.map(file => file.content), ["global context", "ancestor context", "snapshot override"]);
	});
});
