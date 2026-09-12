#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(realpath -- "${script_dir}/..")
staging=""
dry_run=0
destination_arg=""

log_info() { printf 'publish-local-package: %s\n' "$*" >&2; }
log_error() { printf 'publish-local-package: error: %s\n' "$*" >&2; }

usage() {
	cat <<'EOF'
Usage: publish-local-package.sh [--destination DIR] [--dry-run]

Copy package.json, config/, and extensions/ into a local Pi package snapshot.
Does not edit settings.json, user route files, or ~/.pi/agent/extensions/.
EOF
}

cleanup() {
	if [[ -n ${staging} && -d ${staging} ]]; then
		rm -rf -- "${staging}"
	fi
}

die() {
	log_error "$1"
	exit "${2:-1}"
}

resolved() {
	realpath -m -- "$1"
}

is_same() {
	[[ $(resolved "$1") == "$(resolved "$2")" ]]
}

is_inside() {
	local child parent
	child=$(resolved "$1")
	parent=$(resolved "$2")
	[[ ${child} == "${parent}" || ${child} == "${parent}"/* ]]
}

trap cleanup EXIT
trap 'log_error "failed at line ${LINENO}"' ERR

while [[ $# -gt 0 ]]; do
	case $1 in
	--destination)
		[[ $# -ge 2 ]] || die "--destination requires a directory" 2
		destination_arg=$2
		shift 2
		;;
	--dry-run)
		dry_run=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die "unknown argument: $1" 2
		;;
	esac
done

command -v rsync >/dev/null || die "rsync is required"
command -v jq >/dev/null || die "jq is required"

[[ -f "${repo_root}/package.json" ]] || die "package.json is missing"
[[ $(jq -r '.name // empty' "${repo_root}/package.json") == "@csheng/pi-extensions" ]] || die "source is not @csheng/pi-extensions"
[[ -f "${repo_root}/config/csheng-subagents.json" ]] || die "packaged route baseline is missing"
[[ -d "${repo_root}/extensions" ]] || die "extensions/ is missing"

agent_dir=$(resolved "${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}")
if [[ -n "${destination_arg}" ]]; then
	destination=${destination_arg}
else
	destination="${agent_dir}/packages/csheng-pi-extensions"
fi
destination=$(resolved "${destination}")

if is_inside "${destination}" "${repo_root}"; then
	die "destination must not be the source checkout"
fi
if is_same "${destination}" "${agent_dir}" || is_same "${destination}" "${HOME}" || is_same "${destination}" "/"; then
	die "destination must not be the agent directory, home, or /"
fi
if is_inside "${destination}" "${agent_dir}/extensions"; then
	die "destination must not be ~/.pi/agent/extensions or a path inside it"
fi
if [[ -e "${destination}" && ! -d "${destination}" ]]; then
	die "destination exists and is not a directory"
fi
if [[ -L "${destination}" ]]; then
	die "destination must not be a symlink"
fi
if [[ -e "${destination}/.git" ]]; then
	die "destination must not be a Git checkout"
fi

staging=$(mktemp -d)
rsync -a -- "${repo_root}/package.json" "${staging}/package.json"
rsync -a -- "${repo_root}/config/" "${staging}/config/"
rsync -a -- "${repo_root}/extensions/" "${staging}/extensions/"

[[ -f "${staging}/package.json" ]] || die "staged package.json is missing"
[[ -f "${staging}/config/csheng-subagents.json" ]] || die "staged route baseline is missing"
if [[ -e "${staging}/tests" || -e "${staging}/node_modules" || -e "${staging}/.git" ]]; then
	die "staging included excluded source paths"
fi

if [[ ${dry_run} -eq 1 ]]; then
	log_info "dry-run destination=${destination}"
	rsync -a -n --delete -- "${staging}/" "${destination}/"
	jq -cn --arg destination "${destination}" '{result:"dry-run",destination:$destination}'
	exit 0
fi

mkdir -p -- "$(dirname -- "${destination}")"
mkdir -p -- "${destination}"
chmod 700 -- "${destination}"
rsync -a --delete -- "${staging}/" "${destination}/"

[[ -f "${destination}/package.json" ]] || die "published package.json is missing"
[[ -f "${destination}/config/csheng-subagents.json" ]] || die "published route baseline is missing"
[[ -f "${destination}/extensions/subagents/index.ts" ]] || die "published extensions are missing"

log_info "published destination=${destination}"
jq -cn --arg destination "${destination}" '{result:"pass",destination:$destination}'
