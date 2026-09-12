import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/publish-local-package.sh", import.meta.url));

interface PackageManifest {
	files?: string[];
}

async function makeTempDir(t: test.TestContext, prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	return directory;
}

function runPublisher(
	args: string[],
	env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
	return spawnSync("bash", [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

test("publisher copies only the package snapshot and deletes extra destination files", async (t) => {
	const destination = join(await makeTempDir(t, "pi-extensions-snapshot-"), "csheng-pi-extensions");
	await mkdir(destination, { recursive: true });
	await writeFile(join(destination, "stale.txt"), "stale\n");
	await mkdir(join(destination, "extra-dir"), { recursive: true });

	const result = runPublisher(["--destination", destination]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { result: "pass", destination });

	const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as PackageManifest;
	assert.deepEqual(manifest.files, ["config/", "extensions/"]);
	assert.equal(JSON.parse(await readFile(join(destination, "package.json"), "utf8")).name, "@csheng/pi-extensions");
	assert.ok((await readFile(join(destination, "config/csheng-subagents.json"), "utf8")).length > 0);
	assert.ok((await readFile(join(destination, "extensions/subagents/config.ts"), "utf8")).includes("../../config/csheng-subagents.json"));
	assert.deepEqual((await readdir(destination)).sort(), ["config", "extensions", "package.json"]);
});

test("publisher default destination stays under PI_CODING_AGENT_DIR/packages", async (t) => {
	const agentDir = await makeTempDir(t, "pi-extensions-agent-");
	const destination = join(agentDir, "packages", "csheng-pi-extensions");
	const result = runPublisher([], { PI_CODING_AGENT_DIR: agentDir });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { result: "pass", destination });
	assert.ok((await readFile(join(destination, "package.json"), "utf8")).includes("@csheng/pi-extensions"));
});

test("publisher refuses the source checkout and agent extensions directory", async (t) => {
	const source = runPublisher(["--destination", ROOT]);
	assert.equal(source.status, 1, source.stderr);
	assert.match(source.stderr, /must not be the source checkout/);

	const agentDir = await makeTempDir(t, "pi-extensions-agent-ext-");
	const extensionsDir = join(agentDir, "extensions");
	const nested = runPublisher(["--destination", join(extensionsDir, "plan-mode")], {
		PI_CODING_AGENT_DIR: agentDir,
	});
	assert.equal(nested.status, 1, nested.stderr);
	assert.match(nested.stderr, /must not be ~\/\.pi\/agent\/extensions/);
});

test("publisher dry-run does not create the destination", async (t) => {
	const destination = join(await makeTempDir(t, "pi-extensions-dry-run-"), "missing", "csheng-pi-extensions");
	const result = runPublisher(["--destination", destination, "--dry-run"]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { result: "dry-run", destination });
	const probe = spawnSync("test", ["-e", destination]);
	assert.equal(probe.status, 1);
});
