#!/usr/bin/env bash
set -Eeuo pipefail

work_root=$(mktemp -d)
cleanup() { rm -rf -- "${work_root}"; }
trap cleanup EXIT
git -C "${work_root}" init -q

installed_output=$(cd -- "${work_root}" && printf '%s\n' '{"type":"get_commands"}' | PI_OFFLINE=1 pi --mode rpc --no-session --no-context-files --no-approve)
installed_count=$(jq -r 'select(.type == "response" and .command == "get_commands" and .success == true) | [.data.commands[]? | select(.name == "workflow-harness-status")] | length' <<<"${installed_output}")
[[ ${installed_count} == 1 ]]

off_output=$(cd -- "${work_root}" && printf '%s\n' '{"type":"get_commands"}' | PI_OFFLINE=1 pi --mode rpc --no-session --no-skills --no-context-files --no-approve --no-extensions)
off_count=$(jq -r 'select(.type == "response" and .command == "get_commands" and .success == true) | [.data.commands[]? | select(.name == "workflow-harness-status")] | length' <<<"${off_output}")
[[ ${off_count} == 0 ]]
jq -cn '{status:"ok",installed_instances:1,extension_off_instances:0}'
