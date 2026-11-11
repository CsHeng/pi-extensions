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

const packageRoot = process.env.PI_EXTENSIONS_PROBE_PACKAGE_ROOT ?? "";

const isPackagePath = (value: unknown): boolean =>
	typeof value === "string" && packageRoot.length > 0 && (value === packageRoot || value.startsWith(packageRoot + "/"));

export default function probe(pi: ExtensionAPI): void {
	pi.registerCommand("agent-probe", {
		description: "Redacted agent package probe",
		handler: async () => {
			const tools = pi.getAllTools();
			const commands = pi.getCommands();
			const managedTool = tools.find((tool) => tool.name === "agent");
			const managed = managedTool !== undefined;
			const managedSource = isPackagePath(managedTool?.sourceInfo?.path);
			const ui = commands.some((command) => command.name === "agents-ui" && isPackagePath(command.sourceInfo?.path));
			pi.appendEntry("agents-probe", { managed, managedSource, ui });
		},
	});
}
EOF

rpc_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"get_commands"}' \
		'{"type":"prompt","message":"/agent-probe"}' \
		'{"type":"get_entries"}' |
		PI_EXTENSIONS_PROBE_PACKAGE_ROOT="${repo_root}" PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${repo_root}/extensions/agents/index.ts" \
			--extension "${repo_root}/extensions/agents-ui/index.ts" \
			--extension "${probe_extension}"
)

tool_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "agents-probe" and .data.managed == true and .data.managedSource == true and .data.ui == true)] | length' <<<"${rpc_output}")
command_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "agents")] | length' <<<"${rpc_output}")
ui_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "agents-ui")] | length' <<<"${rpc_output}")
[[ ${tool_count} -ge 1 ]]
[[ ${command_count} -eq 1 ]]
[[ ${ui_count} -eq 1 ]]

off_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"get_commands"}' \
		'{"type":"prompt","message":"/agent-probe"}' \
		'{"type":"get_entries"}' |
		PI_EXTENSIONS_PROBE_PACKAGE_ROOT="${repo_root}" PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${probe_extension}"
)
off_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "agents-probe" and .data.managed == false and .data.managedSource == false and .data.ui == false)] | length' <<<"${off_output}")
off_command_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "agents" or .name == "agents-ui")] | length' <<<"${off_output}")
[[ ${off_count} -ge 1 ]]
[[ ${off_command_count} -eq 0 ]]

jq -cn '{result:"pass",source:"temporary",managed_tool:1,command:1,ui:1,source_identity:1,extension_off_managed_tool:0,extension_off_ui:0}'
