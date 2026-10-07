import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedHostEnvironment } from "./installed-host-env.ts";
import { filesForLane, inventoryProblems } from "./test-lane-inventory.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const testsDirectory = join(root, "tests");
const problems = inventoryProblems(testsDirectory);
if (problems.length > 0) {
	for (const problem of problems) console.error(problem);
	console.error("Test lane inventory drift; assign each tests/*.test.ts entry explicitly.");
	process.exit(1);
}

const lane = process.argv[2];
const names = filesForLane(lane as "fast" | "isolated" | "host-optional" | "host-required" | "ui-required");
if (!["fast", "isolated", "host-optional", "host-required", "ui-required"].includes(lane ?? "")) {
	console.error("Usage: bun scripts/run-test-lane.ts fast|isolated|host-optional|host-required|ui-required");
	process.exit(2);
}
const env = lane === "host-optional" || lane === "host-required" || lane === "ui-required"
	? installedHostEnvironment() : process.env;
if (lane === "host-required" || lane === "ui-required") {
	const pi = spawnSync("pi", ["--version"], { env, encoding: "utf8", timeout: 5000 });
	if (pi.status !== 0) { console.error("Installed Pi unavailable; required host lane cannot pass."); process.exit(1); }
}
if (lane === "ui-required") {
	for (const path of ["/usr/bin/script", join(homedir(), ".pi/agent/npm/node_modules/pi-cc-extensions/extensions/index.ts")]) {
		if (!existsSync(path)) { console.error(`Required UI prerequisite unavailable: ${path}`); process.exit(1); }
	}
}
const args = ["test", "--timeout", "120000", ...names.map(name => `./tests/${name}`)];
if (lane === "ui-required") args.push("./tests/subagents-ui-tui.e2e.ts");
const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error);
if ((lane === "host-required" || lane === "ui-required") && /\(skip\)|\(todo\)/.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) {
	console.error("Required host test skipped; host acceptance unavailable.");
	process.exit(1);
}
process.exit(result.status ?? 1);
