#!/usr/bin/env bun
// Provider-gated measurement lane for the parent-visible subagent surface.
//
// It runs headless `pi` against a throwaway project and one mock subagent tool
// (scripts/fixtures/delegation-probe-extension.ts), then reports how often the
// parent model called that tool. It measures a decision, not child quality, and
// it is never a pass/fail gate. Results are dated evaluation evidence for
// $AGENT_ARCHITECTURE_DIR/docs/evaluations/pi-integration/.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROBE_GUIDANCE_ENV, PROBE_GUIDANCE_LEVELS, PROBE_SHAPES, PROBE_SHAPE_ENV, PROBE_TOOL_NAMES, type ProbeGuidance, type ProbeShape } from "./fixtures/delegation-probe-extension.ts";

export const PROBE_GATE_ENV = "CSHENG_SUBAGENTS_DELEGATION_PROBE";
export const PROBE_FIXTURE_RELATIVE_PATH = "scripts/fixtures/delegation-probe-extension.ts";
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 600;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probeFixturePath = join(repositoryRoot, PROBE_FIXTURE_RELATIVE_PATH);
const subagentTools = new Set<string>(PROBE_TOOL_NAMES);

export type ProbePromptKind = "target" | "control";
export interface ProbePrompt { id: string; kind: ProbePromptKind; text: string }

/**
 * Frozen prompt set. Every cell uses these exact texts so results stay
 * comparable across dates; the recorded fingerprint fails in
 * tests/subagents-delegation-probe.test.ts until it is updated in the same
 * change as a deliberate prompt edit.
 */
export const PROBE_PROMPTS: readonly ProbePrompt[] = [
	{
		id: "survey",
		kind: "target",
		text: "当前目录下的 repo/ 是一份代码库拷贝，其中 repo/extensions 下是八个 Pi 扩展。请只依据这份拷贝把它们逐个梳理清楚：每个扩展的职责是什么，注册了哪些工具或命令，依赖哪些共享模块，最后给我一张完整的对照表。",
	},
	{
		id: "module-summary",
		kind: "control",
		text: "当前目录下 proj/src 里有 6 个业务模块：store.py、collector.py、parser.py、report.py、thresholds.py、export.py。请逐个把每个模块的职责、对外接口和它依赖的其他模块查清楚，最后给我一张汇总表。",
	},
	{
		id: "version-check",
		kind: "control",
		text: "proj/README.md 说需要 Python 3.11+，proj/pyproject.toml 里写的是 >=3.12。确认哪个才是实际生效的约束，按代码的实际情况给出结论。",
	},
];

export function promptSetFingerprint(prompts: readonly ProbePrompt[] = PROBE_PROMPTS): string {
	const canonical = JSON.stringify(prompts.map((prompt) => [prompt.id, prompt.kind, prompt.text]));
	return createHash("sha256").update(canonical).digest("hex");
}

export function assertProbeAuthorized(env: Record<string, string | undefined>): void {
	if (env[PROBE_GATE_ENV] !== "1") {
		throw new Error(`delegation_probe_requires_${PROBE_GATE_ENV}_1`);
	}
}

export interface ProbeEventCounts {
	called: boolean;
	callCount: number;
	argErrors: number;
	otherToolCalls: number;
	turns: number;
	stopReason: string | null;
	costUsd: number;
	settled: boolean;
}

/** Parses one `pi --mode json|rpc` event stream; both modes share the wire events. */
export function parseProbeEvents(lines: readonly string[]): ProbeEventCounts {
	const counts: ProbeEventCounts = { called: false, callCount: 0, argErrors: 0, otherToolCalls: 0, turns: 0, stopReason: null, costUsd: 0, settled: false };
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		const type = event["type"];
		if (type === "turn_start") counts.turns += 1;
		else if (type === "tool_execution_start") {
			const name = String(event["toolName"] ?? "");
			if (subagentTools.has(name)) {
				counts.callCount += 1;
				counts.called = true;
			} else counts.otherToolCalls += 1;
		} else if (type === "tool_execution_end") {
			if (subagentTools.has(String(event["toolName"] ?? "")) && event["isError"] === true) counts.argErrors += 1;
		} else if (type === "message_end") {
			const message = (event["message"] ?? {}) as Record<string, unknown>;
			if (message["role"] === "assistant" && typeof message["stopReason"] === "string") counts.stopReason = message["stopReason"];
			const usage = (message["usage"] ?? {}) as Record<string, unknown>;
			const cost = usage["cost"];
			if (cost && typeof cost === "object" && typeof (cost as Record<string, unknown>)["total"] === "number") counts.costUsd += (cost as Record<string, number>)["total"] ?? 0;
		} else if (type === "agent_settled") counts.settled = true;
	}
	return counts;
}

/** Wilson score interval for a binomial rate; reported so small cells are not over-read. */
export function wilsonInterval(successes: number, total: number, z = 1.96): { low: number; high: number } {
	if (total === 0) return { low: 0, high: 0 };
	const p = successes / total;
	const denominator = 1 + (z * z) / total;
	const center = p + (z * z) / (2 * total);
	const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
	return { low: Math.max(0, (center - spread) / denominator), high: Math.min(1, (center + spread) / denominator) };
}

export interface ProbeRunResult {
	shape: ProbeShape;
	guidance: ProbeGuidance;
	mode: ProbeMode;
	promptId: string;
	promptKind: ProbePromptKind;
	trial: number;
	called: boolean;
	callCount: number;
	argErrors: number;
	otherToolCalls: number;
	turns: number;
	stopReason: string | null;
	settled: boolean;
	timedOut: boolean;
	exitCode: number | null;
	durationMs: number;
	costUsd: number;
	error?: string;
}
export type ProbeMode = "print" | "rpc";

export function summarizeCell(rows: readonly ProbeRunResult[]): Record<string, unknown> {
	const called = rows.filter((row) => row.called).length;
	const turns = rows.map((row) => row.turns).sort((a, b) => a - b);
	const interval = wilsonInterval(called, rows.length);
	return {
		runs: rows.length,
		called,
		rate: rows.length === 0 ? null : called / rows.length,
		rateWilson95: { low: interval.low, high: interval.high },
		argErrors: rows.reduce((sum, row) => sum + row.argErrors, 0),
		timedOut: rows.filter((row) => row.timedOut).length,
		medianTurns: turns.length === 0 ? null : turns[Math.floor(turns.length / 2)],
		costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
	};
}

export async function writeProbeProject(root: string): Promise<void> {
	const projectRoot = join(root, "proj");
	await mkdir(join(projectRoot, "src"), { recursive: true });
	const files: Record<string, string> = {
		"proj/README.md": "# Acme Metrics\n\nA small metrics aggregation service. Requires Python 3.11 or newer.\n",
		"proj/pyproject.toml": "[project]\nname = \"acme-metrics\"\nversion = \"0.4.0\"\nrequires-python = \">=3.12\"\ndependencies = []\n",
		"proj/src/__init__.py": "from .collector import collect\nfrom .store import Store\n",
		"proj/src/store.py": "class Store:\n    \"\"\"In-memory metric store with TTL expiry.\"\"\"\n\n    def __init__(self, ttl_seconds=300):\n        self._rows = {}\n        self._ttl = ttl_seconds\n\n    def put(self, name, value, now):\n        self._rows[name] = (value, now + self._ttl)\n\n    def get(self, name, now):\n        row = self._rows.get(name)\n        if row is None or row[1] < now:\n            return None\n        return row[0]\n",
		"proj/src/collector.py": "from .store import Store\n\n\ndef collect(samples, store, now):\n    \"\"\"Write each sample into the store and return the accepted count.\"\"\"\n    accepted = 0\n    for name, value in samples:\n        if value is None:\n            continue\n        store.put(name, value, now)\n        accepted += 1\n    return accepted\n",
		"proj/src/parser.py": "def parse_line(line):\n    \"\"\"Parse 'name=value' into a tuple, or None when malformed.\"\"\"\n    if \"=\" not in line:\n        return None\n    name, raw = line.split(\"=\", 1)\n    try:\n        return name.strip(), float(raw)\n    except ValueError:\n        return None\n",
		"proj/src/report.py": "def summarize(rows, window):\n    \"\"\"Group stored rows by metric name inside the window.\"\"\"\n    grouped = {}\n    for name, value in rows:\n        grouped.setdefault(name, []).append(value)\n    return {name: {\"count\": len(values), \"window\": window} for name, values in grouped.items()}\n",
		"proj/src/thresholds.py": "DEFAULTS = {\"cpu\": 0.9, \"memory\": 0.85}\n\n\ndef breaches(name, value):\n    \"\"\"Return True when a value exceeds the configured threshold.\"\"\"\n    limit = DEFAULTS.get(name)\n    return limit is not None and value > limit\n",
		"proj/src/export.py": "import json\n\n\ndef to_json(rows):\n    \"\"\"Serialize a list of (name, value) rows.\"\"\"\n    return json.dumps(rows, separators=(\",\", \":\"))\n",
	};
	for (const [relativePath, content] of Object.entries(files)) await writeFile(join(root, relativePath), content);
	// A read-only copy of this repository supplies the multi-module survey target.
	await cp(join(repositoryRoot, "extensions"), join(root, "repo", "extensions"), {
		recursive: true,
		filter: (source) => !source.includes("node_modules"),
	});
	for (const name of ["config", "docs", "package.json", "README.md", "AGENTS.md"]) {
		await cp(join(repositoryRoot, name), join(root, "repo", name), { recursive: true, filter: (source) => !source.includes("node_modules") });
	}
}

export interface ProbeRunOptions {
	shape: ProbeShape;
	guidance: ProbeGuidance;
	mode: ProbeMode;
	prompt: ProbePrompt;
	trial: number;
	projectRoot: string;
	model: string;
	thinking: string;
	timeoutSeconds: number;
}

export async function runProbeTrial(options: ProbeRunOptions): Promise<ProbeRunResult> {
	const started = performance.now();
	const args = options.mode === "print"
		? ["-p", "--mode", "json", "-nc", "--no-session", "-na", "--no-extensions", "-e", probeFixturePath, "--model", options.model, "--thinking", options.thinking, "--", options.prompt.text]
		: ["--mode", "rpc", "-nc", "--no-session", "-na", "--no-extensions", "-e", probeFixturePath, "--model", options.model, "--thinking", options.thinking];
	const child = spawn("pi", args, {
		cwd: options.projectRoot,
		env: { ...process.env, [PROBE_SHAPE_ENV]: options.shape, [PROBE_GUIDANCE_ENV]: options.guidance },
		// Print mode must not inherit an open stdin pipe: pi reads a non-TTY stdin as piped
		// prompt input and would wait for EOF instead of running the argument prompt.
		stdio: [options.mode === "rpc" ? "pipe" : "ignore", "pipe", "pipe"],
	});
	const lines: string[] = [];
	let bytes = 0;
	let settled = false;
	const consume = (chunk: Buffer): void => {
		bytes += chunk.byteLength;
		if (bytes > MAX_STDOUT_BYTES) return;
		for (const line of chunk.toString().split("\n")) {
			lines.push(line);
			if (line.includes("\"agent_settled\"")) settled = true;
			if (options.mode === "rpc" && settled) {
				try { child.stdin?.end(); } catch { /* already closed */ }
			}
		}
	};
	child.stdout?.on("data", consume);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, options.timeoutSeconds * 1000);
	if (options.mode === "rpc") {
		child.stdin?.write(`${JSON.stringify({ id: "probe-1", type: "prompt", message: options.prompt.text })}\n`);
		// Closing stdin is the protocol exit; a process that ignores it is bounded here.
		setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 15_000).unref();
	}
	const exitCode = await new Promise<number | null>((resolveExit) => {
		child.on("error", () => resolveExit(null));
		child.on("close", (code) => resolveExit(code));
	});
	clearTimeout(timeout);
	const counts = parseProbeEvents(lines);
	const result: ProbeRunResult = {
		shape: options.shape,
		guidance: options.guidance,
		mode: options.mode,
		promptId: options.prompt.id,
		promptKind: options.prompt.kind,
		trial: options.trial,
		...counts,
		timedOut,
		exitCode,
		durationMs: Math.round(performance.now() - started),
		costUsd: Number(counts.costUsd.toFixed(5)),
	};
	if (timedOut && result.error === undefined) result.error = `timeout_after_${options.timeoutSeconds}s`;
	else if (exitCode !== 0 && result.error === undefined) result.error = stderr.slice(-300) || `exit_${exitCode}`;
	return result;
}

async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			const item = items[index];
			if (item !== undefined) await worker(item);
		}
	});
	await Promise.all(lanes);
}

function formatRate(cell: Record<string, unknown>): string {
	const rate = cell["rate"] as number | null;
	if (rate === null) return "n/a";
	const interval = cell["rateWilson95"] as { low: number; high: number };
	return `${cell["called"]}/${cell["runs"]} (${(rate * 100).toFixed(0)}%, 95% ${(interval.low * 100).toFixed(0)}-${(interval.high * 100).toFixed(0)}%)`;
}

async function repositoryRevision(): Promise<string> {
	try {
		const child = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
		await new Promise((resolveExit) => child.on("close", resolveExit));
		return Buffer.concat(chunks).toString().trim() || "unknown";
	} catch {
		return "unknown";
	}
}

async function piVersion(): Promise<string> {
	try {
		const child = spawn("pi", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
		await new Promise((resolveExit) => child.on("close", resolveExit));
		return Buffer.concat(chunks).toString().trim() || "unknown";
	} catch {
		return "unknown";
	}
}

const USAGE = `Delegation probe lane (provider calls required; never a pass/fail gate)

Usage: ${PROBE_GATE_ENV}=1 bun scripts/run-delegation-probe.ts [options]

Options:
  --shapes <list>       ${PROBE_SHAPES.join(",")} (default: production)
  --guidance <list>     ${PROBE_GUIDANCE_LEVELS.join(",")} (default: aggressive)
  --modes <list>        print,rpc (default: print)
  --prompts <list>      all,target,control, or explicit ids (default: all)
  --trials <n>          runs per cell (default: 6)
  --concurrency <n>     parallel pi processes (default: 4)
  --model <ref>         parent model (default: deepseek/deepseek-flash)
  --thinking <level>    parent thinking level (default: high)
  --timeout <seconds>   per-run timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --out <path>          JSON artifact path (default: $AGENT_TMP_ROOT/extensions/delegation-probe-<timestamp>.json)
  --dry-run             print the plan and exit without provider calls

Every cell always includes the control prompts; report sensitivity and specificity together.`;

async function main(argv: readonly string[]): Promise<void> {
	const { values } = parseArgs({ args: [...argv], options: {
		shapes: { type: "string", default: "production" },
		guidance: { type: "string", default: "aggressive" },
		modes: { type: "string", default: "print" },
		prompts: { type: "string", default: "all" },
		trials: { type: "string", default: "6" },
		concurrency: { type: "string", default: "4" },
		model: { type: "string", default: "deepseek/deepseek-flash" },
		thinking: { type: "string", default: "high" },
		timeout: { type: "string", default: String(DEFAULT_TIMEOUT_SECONDS) },
		out: { type: "string" },
		"dry-run": { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	} });
	if (values.help) {
		console.log(USAGE);
		return;
	}
	const shapes = values.shapes.split(",").map((value) => value.trim()).filter(Boolean) as ProbeShape[];
	const guidance = values.guidance.split(",").map((value) => value.trim()).filter(Boolean) as ProbeGuidance[];
	const modes = values.modes.split(",").map((value) => value.trim()).filter(Boolean) as ProbeMode[];
	for (const shape of shapes) if (!PROBE_SHAPES.includes(shape)) throw new Error(`unknown_shape:${shape}`);
	for (const level of guidance) if (!PROBE_GUIDANCE_LEVELS.includes(level)) throw new Error(`unknown_guidance:${level}`);
	for (const mode of modes) if (mode !== "print" && mode !== "rpc") throw new Error(`unknown_mode:${mode}`);
	const selected = values.prompts === "all"
		? PROBE_PROMPTS
		: PROBE_PROMPTS.filter((prompt) => values.prompts.split(",").map((value) => value.trim()).includes(prompt.id) || values.prompts.split(",").map((value) => value.trim()).includes(prompt.kind));
	if (selected.length === 0 || shapes.length === 0 || guidance.length === 0 || modes.length === 0) throw new Error("empty_probe_selection");
	const trials = Number.parseInt(values.trials, 10);
	const timeoutSeconds = Number.parseInt(values.timeout, 10);
	const totalRuns = shapes.length * guidance.length * modes.length * selected.length * trials;
	console.log(`delegation probe plan: ${totalRuns} runs = ${shapes.length} shapes x ${guidance.length} guidance x ${modes.length} modes x ${selected.length} prompts x ${trials} trials`);
	console.log(`  model=${values.model} thinking=${values.thinking} concurrency=${values.concurrency} timeout=${timeoutSeconds}s`);
	console.log(`  promptSetFingerprint=${promptSetFingerprint().slice(0, 16)} target=${selected.filter((prompt) => prompt.kind === "target").length} control=${selected.filter((prompt) => prompt.kind === "control").length}`);
	if (values["dry-run"]) return;
	assertProbeAuthorized(process.env);

	const root = await mkdtemp(join(tmpdir(), "delegation-probe-"));
	const results: ProbeRunResult[] = [];
	try {
		await writeProbeProject(root);
		const jobs: ProbeRunOptions[] = [];
		for (const shape of shapes) for (const level of guidance) for (const mode of modes) for (const prompt of selected) {
			for (let trial = 0; trial < trials; trial += 1) {
				jobs.push({ shape, guidance: level, mode, prompt, trial, projectRoot: root, model: values.model, thinking: values.thinking, timeoutSeconds });
			}
		}
		await runPool(jobs, Number.parseInt(values.concurrency, 10), async (job) => {
			const result = await runProbeTrial(job);
			results.push(result);
			console.log(`  ${job.shape}/${job.guidance}/${job.mode}/${job.prompt.id}#${job.trial} called=${result.called} calls=${result.callCount} turns=${result.turns} ${Math.round(result.durationMs / 1000)}s${result.timedOut ? " TIMEOUT" : ""}${result.argErrors > 0 ? " ARG_ERROR" : ""}`);
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}

	const cells = new Map<string, ProbeRunResult[]>();
	for (const result of results) {
		const key = `${result.shape}/${result.guidance}/${result.mode}/${result.promptId}`;
		cells.set(key, [...(cells.get(key) ?? []), result]);
	}
	console.log("\n=== summary ===");
	const summary: Record<string, unknown> = {};
	for (const [key, rows] of [...cells.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const cell = summarizeCell(rows);
		summary[key] = cell;
		console.log(`  ${key.padEnd(48)} ${formatRate(cell)}`);
	}
	const artifact = {
		version: 1,
		generatedAt: new Date().toISOString(),
		measurement: "parent model calls the registered subagent tool in a throwaway project; mock executor, so this is a call decision and not child quality",
		method: {
			piVersion: await piVersion(),
			repositoryRevision: await repositoryRevision(),
			fixture: PROBE_FIXTURE_RELATIVE_PATH,
			model: values.model,
			thinking: values.thinking,
			modes,
			shapes,
			guidance,
			trials,
			concurrency: Number.parseInt(values.concurrency, 10),
			prompts: selected.map((prompt) => ({ id: prompt.id, kind: prompt.kind, chars: prompt.text.length })),
			promptSetFingerprint: promptSetFingerprint(),
		},
		summary,
		runs: results,
	};
	const agentTmpRoot = process.env["AGENT_TMP_ROOT"];
	if (values.out === undefined && agentTmpRoot === undefined) throw new Error("delegation_probe_requires_out_or_AGENT_TMP_ROOT");
	const out = values.out ?? join(agentTmpRoot ?? tmpdir(), "extensions", `delegation-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, `${JSON.stringify(artifact, null, 1)}\n`);
	console.log(`artifact: ${out}`);
	console.log("reminder: cells are small; only large separations are load-bearing, and control prompts bound over-triggering.");
}

if (import.meta.main) await main(process.argv.slice(2));
