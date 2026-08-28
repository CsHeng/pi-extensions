import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/run-installed-workflow-probe.sh", import.meta.url).pathname;

test("installed probe distinguishes one installed instance from extension-off", async (t) => {
	const shimRoot = await mkdtemp(join(tmpdir(), "workflow-pi-shim-"));
	t.after(async () => rm(shimRoot, { recursive: true, force: true }));
	const shim = join(shimRoot, "pi");
	await writeFile(shim, `#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
if [[ $input != '{"type":"get_commands"}' ]]; then exit 2; fi
instance=1
for argument in "$@"; do
	if [[ $argument == --no-extensions ]]; then instance=0; fi
done
if [[ $instance == 1 ]]; then
	printf '%s\\n' '{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"workflow-harness-status"}]}}'
else
	printf '%s\\n' '{"type":"response","command":"get_commands","success":true,"data":{"commands":[]}}'
fi
`);
	await chmod(shim, 0o700);
	const result = spawnSync("bash", [SCRIPT], {
		encoding: "utf8",
		env: { PATH: `${shimRoot}:${process.env.PATH ?? ""}` },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { status: "ok", installed_instances: 1, extension_off_instances: 0 });
});
