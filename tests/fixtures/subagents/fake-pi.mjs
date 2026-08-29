#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_PI_MODE ?? "normal";
const capture = process.env.FAKE_PI_CAPTURE;
if (capture) {
	writeFileSync(capture, JSON.stringify({
		args: process.argv.slice(2),
		child: process.env.CSHENG_SUBAGENT_CHILD,
		capability: process.env.CSHENG_SUBAGENT_CAPABILITY,
		removedParentMarker: process.env.CSHENG_SUBAGENT_TEST_MODE,
	}));
}

const event = JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: mode === "large" ? "x".repeat(60 * 1024) : "done" }],
		usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, cost: { total: 0.25 } },
		stopReason: "stop",
	},
});

if (mode === "fragmented") {
	process.stdout.write(event.slice(0, 17));
	setTimeout(() => process.stdout.write(`${event.slice(17)}\n`), 5);
} else if (mode === "malformed") {
	process.stdout.write("{not-json}\n");
} else if (mode === "stderr") {
	process.stderr.write("e".repeat(20 * 1024));
	process.stdout.write(`${event}\n`);
} else if (mode === "nonzero") {
	process.stdout.write(`${event}\n`);
	process.exitCode = 7;
} else if (mode === "wait-term") {
	process.on("SIGTERM", () => process.exit(0));
	setInterval(() => {}, 1000);
} else if (mode === "ignore-term") {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
} else {
	process.stdout.write(event);
}
