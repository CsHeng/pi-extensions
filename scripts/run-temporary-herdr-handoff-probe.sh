#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(realpath "${script_dir}/..")
agent_root=$(mktemp -d)
work_root=$(mktemp -d)
cleanup() { rm -rf -- "${agent_root}" "${work_root}"; }
trap cleanup EXIT

git -C "${work_root}" init -q
probe_extension="${work_root}/probe.ts"
cat >"${probe_extension}" <<'EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageRoot = process.env.CSHENG_PROBE_PACKAGE_ROOT ?? "";

const isPackagePath = (value: unknown): boolean =>
	typeof value === "string" && packageRoot.length > 0 && (value === packageRoot || value.startsWith(packageRoot + "/"));

export default function probe(pi: ExtensionAPI): void {
	pi.registerCommand("herdr-handoff-probe", {
		description: "Redacted herdr-handoff package probe",
		handler: async () => {
			const tool = pi.getAllTools().find((candidate) => candidate.name === "herdr_handoff");
			const present = tool !== undefined && isPackagePath(tool.sourceInfo?.path);
			pi.appendEntry("csheng-herdr-handoff-probe", { present });
		},
	});
}
EOF

rpc_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"get_commands"}' \
		'{"type":"prompt","message":"/herdr-handoff-probe"}' \
		'{"type":"get_entries"}' |
		CSHENG_PROBE_PACKAGE_ROOT="${repo_root}" PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 HERDR_ENV='' \
			pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${repo_root}/extensions/herdr-handoff/index.ts" \
			--extension "${probe_extension}"
)

tool_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-herdr-handoff-probe" and .data.present == true)] | length' <<<"${rpc_output}")
command_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "herdr-handoff")] | length' <<<"${rpc_output}")
[[ ${tool_count} -ge 1 ]]
[[ ${command_count} -eq 1 ]]

off_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"prompt","message":"/herdr-handoff-probe"}' \
		'{"type":"get_entries"}' |
		CSHENG_PROBE_PACKAGE_ROOT="${repo_root}" PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 HERDR_ENV='' \
			pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${probe_extension}"
)
off_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-herdr-handoff-probe" and .data.present == false)] | length' <<<"${off_output}")
[[ ${off_count} -ge 1 ]]

bun test --test-name-pattern 'offline fake-herdr delegate-return fixture' "${repo_root}/tests/installed-herdr-handoff-probe.test.ts" >/dev/null

jq -cn '{result:"pass",source:"temporary",tool:1,command:1,extension_off_tool:0,fixture:1}'
