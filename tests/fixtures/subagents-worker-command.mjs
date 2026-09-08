import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode === "check") {
	const source = await readFile("candidate.txt", "utf8");
	if (source !== "fixed") process.exitCode = 2;
	else console.log("verified");
} else if (mode === "delay") {
	await writeFile("started", "yes");
	await new Promise((resolve) => setTimeout(resolve, 150));
	await writeFile("candidate.txt", "from-command");
} else if (mode === "wait") {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
	await writeFile("started", String(child.pid));
	setInterval(() => {}, 1000);
} else if (mode === "search-check") {
	const { createWorkerTools } = await import("../../extensions/subagents/worker-tools.ts");
	const worker = await createWorkerTools({ cwd: process.cwd(), scratch: process.argv[3] });
	const find = worker.tools.find((tool) => tool.name === "find");
	const signal = new AbortController();
	const result = find.execute("find", { pattern: "*" }, signal.signal, undefined, {});
	const rejected = result.then(() => false, () => true);
	while (true) {
		try { await readFile("search-started"); break; }
		catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
	}
	signal.abort();
	await worker.shutdown();
	if (!await rejected) throw new Error("expected cancellation");
	if (await readFile("search-finished", "utf8") !== "yes") throw new Error("search escaped drain");
	console.log("search-drained");
} else if (mode === "output") {
	console.log("x".repeat(80_000));
} else {
	throw new Error("unknown fixture mode");
}
