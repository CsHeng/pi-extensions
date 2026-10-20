#!/usr/bin/env bash
set -Eeuo pipefail

work_root=$(mktemp -d)
cleanup() { rm -rf -- "${work_root}"; }
trap cleanup EXIT

git -C "${work_root}" init -q
skill_one_file="${work_root}/probe-alpha.md"
skill_two_file="${work_root}/probe-beta.md"
probe_extension="${work_root}/probe.ts"
installed_prompt="\$probe-alpha \$probe-beta verify installed expansion"
off_prompt="\$probe-alpha \$probe-beta verify extension-off behavior"

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

# Counts only; this probe reports the grouped envelope shape, not prompt text.
cat >"${probe_extension}" <<'EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probe(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const blocks = event.prompt.match(/^<skill name=/gm)?.length ?? 0;
		const names = event.prompt.includes('name="probe-alpha, probe-beta"') ? 1 : 0;
		const bodies = (event.prompt.match(/Alpha probe body\./g)?.length ?? 0)
			+ (event.prompt.match(/Beta probe body\./g)?.length ?? 0);
		const tail = event.prompt.endsWith("\n\nverify installed expansion") ? 1 : 0;
		process.stderr.write(`MULTI_SKILL_PROBE blocks=${blocks} names=${names} bodies=${bodies} tail=${tail}\n`);
	});
}
EOF

installed_output=$(
	cd -- "${work_root}"
	PI_OFFLINE=1 pi \
		--no-session \
		--no-context-files \
		--no-approve \
		--no-skills \
		--skill "${skill_one_file}" \
		--skill "${skill_two_file}" \
		--extension "${probe_extension}" \
		-p "${installed_prompt}" 2>&1 || true
)
grep -Fxq 'MULTI_SKILL_PROBE blocks=1 names=1 bodies=2 tail=1' <<<"${installed_output}"

off_output=$(
	cd -- "${work_root}"
	PI_OFFLINE=1 pi \
		--no-session \
		--no-context-files \
		--no-approve \
		--no-skills \
		--skill "${skill_one_file}" \
		--skill "${skill_two_file}" \
		--no-extensions \
		--extension "${probe_extension}" \
		-p "${off_prompt}" 2>&1 || true
)
grep -Fxq 'MULTI_SKILL_PROBE blocks=0 names=0 bodies=0 tail=0' <<<"${off_output}"

jq -cn '{result:"pass",source:"installed",skill_blocks:1,grouped_names:1,extension_off_blocks:0}'
