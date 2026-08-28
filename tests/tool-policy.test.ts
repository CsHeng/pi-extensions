import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { consumeExactUserAuthority, issueExactUserAuthority } from "../extensions/workflow-harness/authority.ts";
import { gateToolCall } from "../extensions/workflow-harness/tool-policy.ts";
import type { TaskNodeV1 } from "../extensions/workflow-harness/task-graph.ts";

const task: TaskNodeV1 = {
	taskId: "A",
	description: "synthetic task",
	dependsOn: [],
	readPaths: ["docs"],
	writePaths: ["src/slice"],
	resourceLocks: [],
	isolation: "controller-checkout",
	verification: ["verify-A"],
	doneWhen: ["done-A"],
	review: { required: false, reasons: [] },
	attemptLimit: 1,
	recovery: "fix-forward",
};

test("keeps safe reads available but rejects credentials, unknown, and mixed tools", () => {
	const workspaceRoot = mkdtempSync(join(tmpdir(), "tool-policy-read-"));
	const base = { workspaceRoot, lifecycle: "capture" as const };
	assert.equal(gateToolCall("read", { path: "docs/note.md" }, base).allow, true);
	assert.match(gateToolCall("read", { path: ".env" }, base).reason ?? "", /credential|protected/);
	assert.match(gateToolCall("invented", {}, base).reason ?? "", /fails closed/);
	assert.match(gateToolCall("apply_patch", { patch: "opaque" }, base).reason ?? "", /mixed tool/);
	rmSync(workspaceRoot, { recursive: true, force: true });
});

test("checks path mutations before side effects against the exact active slice", () => {
	const workspaceRoot = mkdtempSync(join(tmpdir(), "tool-policy-write-"));
	mkdirSync(join(workspaceRoot, "src", "slice"), { recursive: true });
	const context = { workspaceRoot, lifecycle: "execute" as const, task, attemptId: "attempt-1" };
	const allowed = gateToolCall("write", { path: "src/slice/file.ts" }, context);
	assert.equal(allowed.allow, true);
	assert.deepEqual(allowed.operation?.paths, ["src/slice/file.ts"]);
	assert.equal(allowed.operation?.suspendedContainment, false);
	assert.match(gateToolCall("edit", { path: "src/other.ts" }, context).reason ?? "", /outside/);
	assert.match(gateToolCall("write", { path: join(tmpdir(), "outside", "file.ts") }, context).reason ?? "", /escapes/);
	assert.match(gateToolCall("write", { path: ".git/config" }, context).reason ?? "", /protected/);
	assert.match(gateToolCall("write", { path: "src/slice/file.ts" }, { ...context, lifecycle: "review" as never }).reason ?? "", /active task/);
	const outside = mkdtempSync(join(tmpdir(), "tool-policy-outside-"));
	symlinkSync(outside, join(workspaceRoot, "src", "slice", "link"));
	assert.match(gateToolCall("write", { path: "src/slice/link/escape.ts" }, context).reason ?? "", /symbolic-link/);
	rmSync(workspaceRoot, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

test("shell needs one exact user-authorized operation and records suspended containment", () => {
	const input = { command: "synthetic-operation" };
	const authority = issueExactUserAuthority({ authorityId: "decision-1", taskId: "A", toolName: "bash", toolInput: input, source: "user" });
	const workspaceRoot = mkdtempSync(join(tmpdir(), "tool-policy-shell-"));
	const base = { workspaceRoot, lifecycle: "execute" as const, task, attemptId: "attempt-1", exactUserAuthority: authority };
	const allowed = gateToolCall("bash", input, base);
	assert.equal(allowed.allow, true);
	assert.equal(allowed.operation?.suspendedContainment, true);
	assert.equal(gateToolCall("bash", input, { ...base, exactUserAuthority: consumeExactUserAuthority(authority) }).allow, false);
	rmSync(workspaceRoot, { recursive: true, force: true });
});
