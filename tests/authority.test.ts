import assert from "node:assert/strict";
import test from "node:test";

import {
	authorityMatches,
	consumeExactUserAuthority,
	issueExactUserAuthority,
	loadAuthoritySettings,
} from "../extensions/workflow-harness/authority.ts";

test("accepts only the closed default-deny settings schema", () => {
	assert.deepEqual(loadAuthoritySettings({ version: 1, mode: "managed", policy: "default-deny" }), {
		version: 1,
		mode: "managed",
		policy: "default-deny",
	});
	assert.throws(
		() => loadAuthoritySettings({ version: 1, mode: "managed", policy: "default-deny", allowShell: true }),
		/closed version-1 schema/,
	);
});

test("uncontained authority is exact, direct-user, and single-use", () => {
	const toolInput = { command: "synthetic-operation" };
	const authority = issueExactUserAuthority({ authorityId: "decision-1", taskId: "A", toolName: "bash", toolInput, source: "user" });
	assert.equal(authorityMatches(authority, "A", "bash", toolInput), true);
	assert.equal(authorityMatches(authority, "A", "bash", { command: "different" }), false);
	assert.equal(authorityMatches(consumeExactUserAuthority(authority), "A", "bash", toolInput), false);
	assert.throws(
		() => issueExactUserAuthority({ authorityId: "decision-2", taskId: "A", toolName: "bash", toolInput, source: "worker" as "user" }),
		/direct user/,
	);
});
