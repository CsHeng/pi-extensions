import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/run-installed-plan-mode-probe.sh", import.meta.url).pathname;

// Stands in for the installed `pi` binary: answers the RPC lines the probe writes,
// and drains stdin to EOF exactly as Pi does before exiting.
const SHIM = `#!/usr/bin/env bash
set -euo pipefail
instance=1
for argument in "$@"; do
	if [[ $argument == --no-extensions ]]; then instance=0; fi
done
if [[ $instance == 1 ]]; then
	printf '%s\\n' \\
		'{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"plan"},{"name":"default"}]}}' \\
		'{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"custom","customType":"csheng-plan-mode","data":{"profile":"plan"}}]}}' \\
		'{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"custom","customType":"csheng-plan-mode","data":{"profile":"default"}}]}}'
else
	printf '%s\\n' '{"type":"response","command":"get_commands","success":true,"data":{"commands":[]}}'
fi
# Real Pi reads stdin to EOF; a shim that exits first sends SIGPIPE to the probe's pipefail writer.
cat >/dev/null || true
`;

async function writeShim(t: test.TestContext, name = "pi"): Promise<{ shimRoot: string; shim: string }> {
	const shimRoot = await mkdtemp(join(tmpdir(), "plan-mode-pi-shim-"));
	t.after(async () => rm(shimRoot, { recursive: true, force: true }));
	const shim = join(shimRoot, name);
	await writeFile(shim, SHIM);
	await chmod(shim, 0o700);
	return { shimRoot, shim };
}

test("installed probe distinguishes the plan mode package from extension-off", async (t) => {
	const { shimRoot } = await writeShim(t);
	const result = spawnSync("bash", [SCRIPT], {
		encoding: "utf8",
		env: { PATH: `${shimRoot}:${process.env.PATH ?? ""}` },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		result: "pass",
		commands: 2,
		plan_entries: "present",
		default_entries: "present",
		extension_off_commands: 0,
	});
});

test("probe shim drains stdin so a writer still in flight cannot fail the probe", async (t) => {
	const { shim } = await writeShim(t, `pi $review "quoted" 'space'`);
	// Delay the writer to exercise early reader exit under pipefail. Pass the path
	// as data: shell metacharacters in the temporary path must remain literal.
	const result = spawnSync("bash", ["-c", `set -Eeuo pipefail; { sleep 0.2; printf '%s\\n' '{"type":"get_commands"}'; } | "$1" --mode rpc`, "probe-test", shim], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
});
