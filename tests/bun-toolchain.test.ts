import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

function runBun(cwd: string, args: string[]): string {
	const result = spawnSync("bun", args, {
		cwd,
		env: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: cwd, BUN_INSTALL_CACHE_DIR: join(cwd, "cache") },
		encoding: "utf8",
		timeout: 20_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("Bun installation disables root and explicitly trusted dependency lifecycle scripts", async t => {
	const root = await mkdtemp(join(tmpdir(), "pi-bun-install-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dependency = join(root, "dependency");
	await mkdir(dependency);
	const scripts = { postinstall: "bun install.cjs" };
	await writeFile(join(root, "package.json"), JSON.stringify({
		name: "install-policy-fixture", private: true, scripts,
		dependencies: { "local-lifecycle-fixture": "file:./dependency" },
		trustedDependencies: ["local-lifecycle-fixture"],
	}));
	await writeFile(join(dependency, "package.json"), JSON.stringify({
		name: "local-lifecycle-fixture", version: "1.0.0", scripts,
	}));
	const installer = "require('node:fs').writeFileSync('lifecycle-ran', 'ran');\n";
	await writeFile(join(root, "install.cjs"), installer);
	await writeFile(join(dependency, "install.cjs"), installer);
	await copyFile(new URL("bunfig.toml", ROOT), join(root, "bunfig.toml"));

	runBun(root, ["install", "--no-progress"]);
	const markers = [join(root, "lifecycle-ran"), join(root, "node_modules/local-lifecycle-fixture/lifecycle-ran")];
	for (const marker of markers) await assert.rejects(readFile(marker), { code: "ENOENT" });

	// Positive control: these same local fixtures execute without the repository policy.
	await rm(join(root, "bunfig.toml"));
	runBun(root, ["install", "--force", "--no-progress"]);
	for (const marker of markers) assert.equal(await readFile(marker, "utf8"), "ran");
});

test("Bun script dispatch accepts installed mode with or without a separator", async t => {
	const root = await mkdtemp(join(tmpdir(), "pi-bun-argv-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { probe: "bun argv.cjs" } }));
	await writeFile(join(root, "argv.cjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
	assert.deepEqual(JSON.parse(runBun(root, ["run", "probe", "--installed"])), ["--installed"]);
	assert.deepEqual(JSON.parse(runBun(root, ["run", "probe", "--", "--installed"])), ["--installed"]);
});
