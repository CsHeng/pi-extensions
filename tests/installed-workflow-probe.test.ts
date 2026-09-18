import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

const SHIM = `#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
session_dir=""
prev=""
extension_count=0
no_extensions=0
for argument in "$@"; do
	if [[ $argument == --no-extensions ]]; then no_extensions=1; fi
	if [[ $prev == --extension ]]; then extension_count=$((extension_count + 1)); fi
	if [[ $prev == --session-dir ]]; then session_dir=$argument; fi
	prev=$argument
done
if [[ -n $session_dir ]]; then
	mkdir -p "$session_dir"
	cat >"$session_dir/session.jsonl" <<'JSONL'
{"type":"custom","customType":"csheng-workflow-state","data":{"schemaVersion":2,"state":{"goal":"Synthetic workflow probe"}}}
JSONL
	printf 'PROBE_DONE\\n'
	exit 0
fi
if grep -q 'workflow-coload-probe' <<<"$input"; then
	printf '%s\\n' '{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"custom","customType":"csheng-workflow-coload","data":{"workflow":true,"managed":true,"subagents":true,"ui":true}}]}}'
	exit 0
fi
if [[ -f "\${PI_CODING_AGENT_DIR:-}/settings.json" ]]; then
	jq -e --arg path "${REPO_ROOT}" '.packages[0] == $path' "\${PI_CODING_AGENT_DIR}/settings.json" >/dev/null
fi
if [[ $no_extensions == 1 && $extension_count -le 1 ]]; then
	printf '%s\\n' '{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"workflow-probe"}]}}' '{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"custom","customType":"csheng-workflow-probe","data":{"tool":false,"source":false,"todo":false}}]}}'
else
	printf '%s\\n' '{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"workflow-probe"}]}}' '{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"custom","customType":"csheng-workflow-probe","data":{"tool":true,"source":true,"todo":false}}]}}'
fi
`;

async function shimRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "workflow-pi-shim-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const shim = join(root, "pi");
	await writeFile(shim, SHIM);
	await chmod(shim, 0o700);
	return root;
}

async function runProbe(t: test.TestContext, script: string, source: string): Promise<void> {
	const root = await shimRoot(t);
	const result = spawnSync("bash", [join(REPO_ROOT, "scripts", script)], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		result: "pass",
		source,
		tool: 1,
		source_identity: 1,
		extension_off_tool: 0,
		coload: 1,
		synthetic_snapshots: 1,
	});
}

test("temporary workflow probe validates registration, co-load, and the synthetic snapshot", async (t) => {
	await runProbe(t, "run-temporary-workflow-probe.sh", "temporary");
});

test("installed workflow probe validates the package surface and the synthetic snapshot", async (t) => {
	await runProbe(t, "run-installed-workflow-probe.sh", "installed");
});
