#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(realpath "${script_dir}/..")
if (( $# == 1 )); then
	settings_target=$1
	if [[ ! -f ${settings_target} ]]; then exit 2; fi
	node "${script_dir}/settings-cutover.mjs" verify "${settings_target}" "${repo_root}" workflowHarness
	exit 0
fi
if (( $# != 0 )); then exit 2; fi
scratch_root=$(mktemp -d)
settings_path="${scratch_root}/settings.json"
backup_path="${scratch_root}/settings.backup.json"
cleanup() { rm -rf -- "${scratch_root}"; }
trap cleanup EXIT

printf '%s\n' '{"packages":["/fixture/legacy"],"legacyHarness":{"opaque":true},"unrelated":{"secret":"must-not-print"}}' >"${settings_path}"
chmod 600 "${settings_path}"
baseline=$(node "${script_dir}/settings-cutover.mjs" baseline "${settings_path}" "${backup_path}")
applied=$(node "${script_dir}/settings-cutover.mjs" apply "${settings_path}" /fixture/legacy /fixture/current legacyHarness workflowHarness)
verified=$(node "${script_dir}/settings-cutover.mjs" verify "${settings_path}" /fixture/current workflowHarness)
restored=$(node "${script_dir}/settings-cutover.mjs" restore "${settings_path}" "${backup_path}")
if grep -q 'must-not-print' <<<"${baseline}${applied}${verified}${restored}"; then exit 1; fi
jq -cn '{status:"ok",structural_preservation:true,restore_verified:true,raw_values_exposed:false}'
