#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(realpath "${script_dir}/..")
agent_root=$(mktemp -d)
work_root=$(mktemp -d)
cleanup() { rm -rf -- "${agent_root}" "${work_root}"; }
trap cleanup EXIT

git -C "${work_root}" init -q

rpc_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"get_commands"}' \
		'{"type":"prompt","message":"/plan"}' \
		'{"type":"get_entries"}' \
		'{"type":"prompt","message":"/default"}' \
		'{"type":"get_entries"}' |
		PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions \
			--extension "${repo_root}/extensions/plan-mode/index.ts"
)

command_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "plan" or .name == "default")] | length' <<<"${rpc_output}")
plan_entry_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-plan-mode" and .data.profile == "plan")] | length' <<<"${rpc_output}")
default_entry_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-plan-mode" and .data.profile == "default")] | length' <<<"${rpc_output}")

[[ ${command_count} -eq 2 ]]
[[ ${plan_entry_count} -ge 1 ]]
[[ ${default_entry_count} -ge 1 ]]

off_output=$(
	cd -- "${work_root}"
	printf '%s\n' '{"type":"get_commands"}' |
		PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--no-extensions
)
off_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "plan" or .name == "default")] | length' <<<"${off_output}")
[[ ${off_count} -eq 0 ]]

jq -cn '{result:"pass",commands:2,plan_entries:"present",default_entries:"present",extension_off_commands:0}'
