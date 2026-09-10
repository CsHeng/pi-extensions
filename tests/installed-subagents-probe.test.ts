import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = fileURLToPath(new URL("../scripts/run-installed-subagents-probe.sh", import.meta.url));

const PASS = {
	result: "pass",
	source: "installed",
	tool: 0,
	managed_tool: 1,
	command: 1,
	ui: 1,
	debug: 0,
	source_identity: 1,
	extension_off_tool: 0,
	extension_off_managed_tool: 0,
	extension_off_ui: 0,
} as const;

test("installed probe distinguishes the subagent package from extension-off", async (t) => {
	const shimRoot = await mkdtemp(join(tmpdir(), "subagent-pi-shim-"));
	t.after(async () => rm(shimRoot, { recursive: true, force: true }));
	const shim = join(shimRoot, "pi");
	await writeFile(shim, `#!/usr/bin/env bash
set -euo pipefail
agent_dir="\${PI_CODING_AGENT_DIR:-}"
[[ -n "\${agent_dir}" ]]
[[ \${PI_OFFLINE:-} == 1 ]]
package_path=$(jq -r '.packages[0] // empty' "\${agent_dir}/settings.json")
[[ "\${package_path}" == ${JSON.stringify(REPO_ROOT)} ]]
instance=1
extension_count=0
prev=""
for argument in "\$@"; do
	if [[ \$argument == --no-extensions ]]; then instance=0; fi
	if [[ \$prev == --extension ]]; then extension_count=\$((extension_count + 1)); fi
	prev=\$argument
done
[[ \${extension_count} -eq 1 ]]
if [[ \$instance == 1 ]]; then
	printf '%s\\n' \\
		'{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"subagents"},{"name":"subagents-ui"}]}}' \\
		'{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"custom","customType":"csheng-subagent-probe","data":{"present":false,"managed":true,"managedSource":true,"ui":true,"debug":false}}]}}'
else
	printf '%s\\n' \\
		'{"type":"response","command":"get_commands","success":true,"data":{"commands":[]}}' \\
		'{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"custom","customType":"csheng-subagent-probe","data":{"present":false,"managed":false,"managedSource":false,"ui":false,"debug":false}}]}}'
fi
# Real Pi reads stdin to EOF; a shim that exits first sends SIGPIPE to the probe's pipefail writer.
cat >/dev/null || true
`);
	await chmod(shim, 0o700);
	const result = spawnSync("bash", [SCRIPT], {
		encoding: "utf8",
		env: { PATH: `${shimRoot}:${process.env.PATH ?? ""}` },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), PASS);
	await writeFile(shim, (await readFile(shim, "utf8")).replace('"managed":true', '"managed":false'));
	const stale = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: `${shimRoot}:${process.env.PATH ?? ""}` } });
	assert.notEqual(stale.status, 0, "legacy-only installed discovery must not claim managed support");
});
