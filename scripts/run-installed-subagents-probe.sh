#!/usr/bin/env bash
set -Eeuo pipefail

work_root=$(mktemp -d)
cleanup() { rm -rf -- "${work_root}"; }
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
			const managed = pi.getAllTools().some((tool) => tool.name === "csheng_subagent_sessions");
			pi.appendEntry("csheng-subagent-probe", { present, managed });
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
		PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--extension "${probe_extension}"
)

tool_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-subagent-probe" and .data.present == true and .data.managed == true)] | length' <<<"${rpc_output}")
command_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "subagents")] | length' <<<"${rpc_output}")
[[ ${tool_count} -ge 1 ]]
[[ ${command_count} -eq 1 ]]

off_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"prompt","message":"/subagent-probe"}' \
		'{"type":"get_entries"}' |
		PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${probe_extension}"
)
off_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-subagent-probe" and .data.present == false and .data.managed == false)] | length' <<<"${off_output}")
[[ ${off_count} -ge 1 ]]

jq -cn '{result:"pass",source:"installed",tool:1,managed_tool:1,command:1,extension_off_tool:0,extension_off_managed_tool:0}'
