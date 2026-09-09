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
	pi.registerCommand("subagent-probe", {
		description: "Redacted subagent package probe",
		handler: async () => {
			const tools = pi.getAllTools();
			const commands = pi.getCommands();
			const present = tools.some((tool) => tool.name === "csheng_subagents");
			const managedTool = tools.find((tool) => tool.name === "csheng_subagent_sessions");
			const managed = managedTool !== undefined;
			const managedSource = isPackagePath(managedTool?.sourceInfo?.path);
			const ui = commands.some((command) => command.name === "subagents-ui" && isPackagePath(command.sourceInfo?.path));
			const debug = commands.some((command) => command.name === "subagents-debug");
			pi.appendEntry("csheng-subagent-probe", { present, managed, managedSource, ui, debug });
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
		CSHENG_PROBE_PACKAGE_ROOT="${repo_root}" PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${repo_root}/extensions/subagents/index.ts" \
			--extension "${repo_root}/extensions/subagents-ui/index.ts" \
			--extension "${probe_extension}"
)

tool_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-subagent-probe" and .data.present == false and .data.managed == true and .data.managedSource == true and .data.ui == true and .data.debug == false)] | length' <<<"${rpc_output}")
command_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "subagents")] | length' <<<"${rpc_output}")
debug_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "subagents-debug")] | length' <<<"${rpc_output}")
ui_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "subagents-ui")] | length' <<<"${rpc_output}")
[[ ${tool_count} -ge 1 ]]
[[ ${command_count} -eq 1 ]]
[[ ${debug_count} -eq 0 ]]
[[ ${ui_count} -eq 1 ]]

off_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"get_commands"}' \
		'{"type":"prompt","message":"/subagent-probe"}' \
		'{"type":"get_entries"}' |
		CSHENG_PROBE_PACKAGE_ROOT="${repo_root}" PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${probe_extension}"
)
off_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-subagent-probe" and .data.present == false and .data.managed == false and .data.managedSource == false and .data.ui == false)] | length' <<<"${off_output}")
off_command_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "subagents" or .name == "subagents-ui" or .name == "subagents-debug")] | length' <<<"${off_output}")
[[ ${off_count} -ge 1 ]]
[[ ${off_command_count} -eq 0 ]]

jq -cn '{result:"pass",source:"temporary",tool:0,managed_tool:1,command:1,ui:1,debug:0,source_identity:1,extension_off_tool:0,extension_off_managed_tool:0,extension_off_ui:0}'
