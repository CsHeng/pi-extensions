#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(realpath "${script_dir}/..")
scratch_root=$(mktemp -d)
copy_root="${scratch_root}/package"
cleanup() { rm -rf -- "${scratch_root}"; }
trap cleanup EXIT

mkdir -p -- "${copy_root}"
tar -C "${repo_root}" --exclude=.git --exclude=node_modules --exclude=docs/plans -cf - . | tar -C "${copy_root}" -xf -
npm --prefix "${copy_root}" ci --ignore-scripts >/dev/null
npm --prefix "${copy_root}" run check >/dev/null
bash "${copy_root}/scripts/run-temporary-load-probe.sh" >/dev/null
jq -cn '{status:"ok",copied_package:true,external_contracts:false}'
