#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(realpath "${script_dir}/..")
agent_root=$(mktemp -d)
work_root=$(mktemp -d)
session_root=$(mktemp -d)
cleanup() { rm -rf -- "${agent_root}" "${work_root}" "${session_root}"; }
trap cleanup EXIT

git -C "${work_root}" init -q
jq -n --arg path "${repo_root}" '{packages:[$path]}' >"${agent_root}/settings.json"

# Registration probe: reports whether the package loaded the workflow tool with its own source.
probe_extension="${work_root}/probe.ts"
cat >"${probe_extension}" <<'EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageRoot = process.env.CSHENG_PROBE_PACKAGE_ROOT ?? "";

const isPackagePath = (value: unknown): boolean =>
	typeof value === "string" && packageRoot.length > 0 && (value === packageRoot || value.startsWith(packageRoot + "/"));

export default function probe(pi: ExtensionAPI): void {
	pi.registerCommand("workflow-probe", {
		description: "Redacted workflow package probe",
		handler: async () => {
			const tool = pi.getAllTools().find((candidate) => candidate.name === "csheng_workflow");
			const managed = pi.getAllTools().some((candidate) => candidate.name === "csheng_subagent_sessions");
			const commands = pi.getCommands();
			pi.appendEntry("csheng-workflow-probe", {
				tool: tool !== undefined,
				source: isPackagePath(tool?.sourceInfo?.path),
				managed,
				subagents: commands.some((command) => command.name === "subagents"),
				ui: commands.some((command) => command.name === "subagents-ui"),
				todo: pi.getAllTools().some((candidate) => candidate.name === "todo"),
			});
		},
	});
}
EOF

rpc_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"get_commands"}' \
		'{"type":"prompt","message":"/workflow-probe"}' \
		'{"type":"get_entries"}' |
		CSHENG_PROBE_PACKAGE_ROOT="${repo_root}" PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--extension "${probe_extension}"
)

present_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-workflow-probe" and .data.tool == true and .data.source == true and .data.todo == false)] | length' <<<"${rpc_output}")
probe_command_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_commands" and .success == true) | .data.commands[]? | select(.name == "workflow-probe")] | length' <<<"${rpc_output}")
[[ ${present_count} -ge 1 ]]
[[ ${probe_command_count} -eq 1 ]]

off_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"prompt","message":"/workflow-probe"}' \
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
off_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-workflow-probe" and .data.tool == false and .data.source == false and .data.todo == false)] | length' <<<"${off_output}")
[[ ${off_count} -ge 1 ]]

# Co-load probe: workflow alongside the managed executor, observer, footer, and timing extensions.
coload_extension="${work_root}/coload-probe.ts"
cat >"${coload_extension}" <<'EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probe(pi: ExtensionAPI): void {
	pi.registerCommand("workflow-coload-probe", {
		description: "Redacted co-load probe",
		handler: async () => {
			const tools = pi.getAllTools().map((tool) => tool.name);
			const commands = pi.getCommands().map((command) => command.name);
			pi.appendEntry("csheng-workflow-coload", {
				workflow: tools.includes("csheng_workflow"),
				managed: tools.includes("csheng_subagent_sessions"),
				subagents: commands.includes("subagents"),
				ui: commands.includes("subagents-ui"),
			});
		},
	});
}
EOF

coload_output=$(
	cd -- "${work_root}"
	printf '%s\n' \
		'{"type":"prompt","message":"/workflow-coload-probe"}' \
		'{"type":"get_entries"}' |
		PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
			--mode rpc \
			--no-session \
			--no-skills \
			--no-context-files \
			--no-approve \
			--extension "${coload_extension}"
)

coload_count=$(jq -s '[.[] | select(.type == "response" and .command == "get_entries" and .success == true) | .data.entries[]? | select(.type == "custom" and .customType == "csheng-workflow-coload" and .data.workflow == true and .data.managed == true and .data.subagents == true and .data.ui == true)] | length' <<<"${coload_output}")
[[ ${coload_count} -ge 1 ]]

# Synthetic-provider lane: the real host executes one workflow tool call and persists a snapshot.
synthetic_extension="${work_root}/synthetic.ts"
cat >"${synthetic_extension}" <<'EOF'
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probe(pi: ExtensionAPI): void {
	let turn = 0;
	pi.registerProvider("wf-probe", {
		baseUrl: "http://invalid.invalid",
		apiKey: "synthetic-not-a-credential",
		api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			const call = turn++;
			void (async () => {
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", content: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				if (call === 0) {
					const toolCall = { type: "toolCall" as const, id: "probe-open", name: "csheng_workflow", arguments: { operation: "open", expectedRevision: 0, goal: "Synthetic workflow probe", deliveryEndpoint: "probe session entry", criteria: [{ key: "c", outcome: "Criterion met", verification: "probe" }], tasks: [{ key: "t", outcome: "Task", covers: ["c"] }] } };
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
					stream.end();
					return;
				}
				message.content = [{ type: "text", text: "PROBE_DONE" }];
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "PROBE_DONE", partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: "PROBE_DONE", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			})();
			return stream;
		},
	});
}
EOF

synthetic_output=$(
	cd -- "${work_root}"
	PI_CODING_AGENT_DIR="${agent_root}" PI_OFFLINE=1 pi \
		--no-skills \
		--no-context-files \
		--no-approve \
		--extension "${synthetic_extension}" \
		--model wf-probe/fixture \
		--session-dir "${session_root}" \
		-p "run the synthetic workflow" 2>&1
)

grep -Fq 'PROBE_DONE' <<<"${synthetic_output}"
session_file=$(find "${session_root}" -name '*.jsonl' -print -quit)
[[ -n ${session_file} ]]
snapshot_count=$(jq -s '[.[] | select(.type == "custom" and .customType == "csheng-workflow-state")] | length' "${session_file}")
[[ ${snapshot_count} -ge 1 ]]
goal=$(jq -sr '[.[] | select(.type == "custom" and .customType == "csheng-workflow-state")] | last | .data.state.workset.goal' "${session_file}")
[[ ${goal} == "Synthetic workflow probe" ]]

jq -cn '{result:"pass",source:"installed",tool:1,source_identity:1,extension_off_tool:0,coload:1,synthetic_snapshots:1}'
