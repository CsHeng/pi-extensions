#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(realpath "${script_dir}/..")
agent_root=$(mktemp -d)
work_root=$(mktemp -d)
cleanup() { rm -rf -- "${agent_root}" "${work_root}"; }
trap cleanup EXIT

git -C "${work_root}" init -q
skill_one_file="${work_root}/probe-alpha.md"
skill_two_file="${work_root}/probe-beta.md"
probe_extension="${work_root}/probe.ts"
prompt_text="\$probe-alpha \$probe-beta verify isolated expansion"

cat >"${skill_one_file}" <<'EOF'
---
name: probe-alpha
description: Isolated alpha probe skill.
---
Alpha probe body.
EOF

cat >"${skill_two_file}" <<'EOF'
---
name: probe-beta
description: Isolated beta probe skill.
---
Beta probe body.
EOF

cat >"${probe_extension}" <<'EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probe(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const blocks = event.prompt.match(/^<skill name=/gm)?.length ?? 0;
		const alpha = event.prompt.includes('<skill name="probe-alpha"') ? 1 : 0;
		const beta = event.prompt.includes('<skill name="probe-beta"') ? 1 : 0;
		process.stderr.write(`MULTI_SKILL_PROBE blocks=${blocks} alpha=${alpha} beta=${beta}\n`);
	});
}
EOF

probe_output=$(
	cd -- "${work_root}"
	PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
		--no-session \
		--no-context-files \
		--no-approve \
		--no-skills \
		--skill "${skill_one_file}" \
		--skill "${skill_two_file}" \
		--no-extensions \
		--extension "${repo_root}/extensions/multi-skill-mentions/index.ts" \
		--extension "${probe_extension}" \
		-p "${prompt_text}" 2>&1 || true
)

grep -Fxq 'MULTI_SKILL_PROBE blocks=2 alpha=1 beta=1' <<<"${probe_output}"
jq -cn '{result:"pass",source:"temporary",skill_blocks:2,extension_off_checked:false}'
