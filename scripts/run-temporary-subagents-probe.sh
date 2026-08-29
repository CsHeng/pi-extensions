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

export default function probe(pi: ExtensionAPI): void {
	pi.registerCommand("subagent-probe", {
		description: "Redacted subagent package probe",
		handler: async () => {
			const present = pi.getAllTools().some((tool) => tool.name === "csheng_subagents");
			pi.appendEntry("csheng-subagent-probe", { present });
		},
	});
}
EOF

rpc_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"get_commands"}' \
		'{"type":"prompt","message":"/subagent-probe"}' \
		'{"type":"get_entries"}' |
		PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${repo_root}/extensions/subagents/index.ts" \
			--extension "${probe_extension}"
)

tool_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-subagent-probe" and .data.present == true)] | length' <<<"${rpc_output}")
command_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "subagents")] | length' <<<"${rpc_output}")
[[ ${tool_count} -ge 1 ]]
[[ ${command_count} -eq 1 ]]

off_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"prompt","message":"/subagent-probe"}' \
		'{"type":"get_entries"}' |
		PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${probe_extension}"
)
off_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-subagent-probe" and .data.present == false)] | length' <<<"${off_output}")
[[ ${off_count} -ge 1 ]]

jq -cn '{result:"pass",source:"temporary",tool:1,command:1,extension_off_tool:0}'
