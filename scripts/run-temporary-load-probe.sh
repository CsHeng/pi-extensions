#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(realpath "${script_dir}/..")
agent_root=$(mktemp -d)
work_root=$(mktemp -d)
cleanup() { rm -rf -- "${agent_root}" "${work_root}"; }
trap cleanup EXIT

git -C "${work_root}" init -q
node "${script_dir}/live-rpc-scenarios.mjs" \
	"${repo_root}/extensions/workflow-harness/index.ts" \
	"${repo_root}/tests/fixtures/synthetic-skills" \
	"${work_root}" \
	"${agent_root}"
