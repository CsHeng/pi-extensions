#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [extensionPath, skillRoot, workRoot, agentRoot] = process.argv.slice(2);
if (!extensionPath || !skillRoot || !workRoot || !agentRoot) throw new Error("usage: live-rpc-scenarios.mjs <extension> <skills> <work> <agent-root>");

function start(extraArgs = [], includeExtension = true) {
	const baseArgs = ["--mode", "rpc", "--no-skills", "--skill", skillRoot, "--no-context-files", "--no-approve"];
	if (includeExtension) baseArgs.push("--extension", extensionPath);
	const child = spawn("pi", [...baseArgs, ...extraArgs], {
		cwd: workRoot,
		env: { PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: agentRoot, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let requestOrdinal = 0;
	let stderr = "";
	const eventTypes = [];
	const pending = new Map();
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	createInterface({ input: child.stdout }).on("line", (line) => {
		let item;
		try { item = JSON.parse(line); } catch { return; }
		if (item.type !== "response" || !item.id) {
			const detail = item.type === "extension_error" ? `:${item.error?.message ?? item.message ?? item.error ?? "unknown"}` : "";
			eventTypes.push(`${item.type ?? "unknown"}${detail}`);
			return;
		}
		const waiter = pending.get(item.id);
		if (!waiter) return;
		pending.delete(item.id);
		if (item.success) waiter.resolve(item.data ?? {});
		else waiter.reject(new Error(`RPC command failed: ${item.command}`));
	});
	const request = (payload) => new Promise((resolve, reject) => {
		const id = `request-${requestOrdinal += 1}`;
		pending.set(id, { resolve, reject });
		child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
	});
	const stop = async () => {
		child.stdin.end();
		const code = await new Promise((resolve) => child.once("close", resolve));
		if (code !== 0) throw new Error(`Pi RPC process exited nonzero; stderr_sha256_only=${stderr.length}`);
	};
	return { request, stop, eventTypes };
}

function ownedStates(entries) {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === "workflow.harness.session.v1").map((entry) => entry.data);
}

async function scenario(prompt) {
	const client = start();
	try {
		const commands = await client.request({ type: "get_commands" });
		const names = commands.commands.map((item) => item.name);
		if (names.filter((name) => name === "workflow-harness-status").length !== 1) throw new Error("diagnostic uniqueness failed");
		const initial = await client.request({ type: "get_entries" });
		if (ownedStates(initial.entries).length !== 0) throw new Error("pass-through unexpectedly created managed state");
		await client.request({ type: "prompt", message: prompt });
		let observedTypes = [];
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const after = await client.request({ type: "get_entries" });
			observedTypes = after.entries.map((entry) => `${entry.type}:${entry.customType ?? ""}`);
			const current = ownedStates(after.entries).at(-1);
			if (current) return current;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`managed state did not become observable after command preflight; entry_types=${observedTypes.join(",")}; event_types=${client.eventTypes.join(",")}`);
	} finally {
		await client.stop();
	}
}

await writeFile(`${workRoot}/standalone-target.txt`, "synthetic standalone target\n");
const formal = await scenario("/workflow-run planning");
if (formal?.formalRole !== "planning" || !formal.stageInstanceId || formal.admissionKind !== "explicit-role") throw new Error(`formal root scenario failed; state_present=${Boolean(formal)} role=${formal?.formalRole ?? "none"} stage=${Boolean(formal?.stageInstanceId)} admission=${formal?.admissionKind ?? "none"}`);
const ordinary = await scenario("/workflow-run none");
if (ordinary?.formalRole !== "none" || ordinary.stageInstanceId !== null || ordinary.reviewReasons.length !== 0) throw new Error("non-formal scenario failed");
const standalone = await scenario("/workflow-review standalone-target.txt standalone");
if (standalone?.formalRole !== "none" || standalone.stageInstanceId !== null || standalone.reviewReasons.length !== 1) throw new Error("standalone review scenario failed");

const off = start(["--no-extensions"], false);
try {
	const commands = await off.request({ type: "get_commands" });
	if (commands.commands.some((item) => item.name === "workflow-harness-status")) throw new Error("extension-off scenario failed");
} finally {
	await off.stop();
}

process.stdout.write(`${JSON.stringify({ status: "ok", pass_through: true, formal_root: true, non_formal_skip: true, standalone_review: true, extension_off: true, raw_state_exposed: false })}\n`);
