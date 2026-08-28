import assert from "node:assert/strict";
import test from "node:test";

import { correlateSkillRead, explicitSkillSelection, snapshotSkills, validateCapabilityResolution } from "../extensions/workflow-harness/skill-discovery.ts";

const commands = [
	{ name: "map-work", description: "Use when a user wants to shape a change", source: "skill", sourceInfo: { path: "/opaque/a/SKILL.md" } },
	{ name: "inspect-result", description: "Use when a user wants an independent assessment", source: "skill", sourceInfo: { path: "/opaque/b/SKILL.md" } },
	{ name: "other", description: "not a Skill", source: "extension", sourceInfo: { path: "/opaque/ext.ts" } },
];

test("snapshots only current Pi Skill commands and observes exact selection", () => {
	const snapshot = snapshotSkills(commands);
	assert.deepEqual(snapshot.skills.map((item) => item.name), ["inspect-result", "map-work"]);
	assert.equal(explicitSkillSelection("/skill:map-work now", snapshot)?.sourcePath, "/opaque/a/SKILL.md");
	assert.equal(correlateSkillRead("read", { path: "/opaque/a/SKILL.md" }, snapshot)?.name, "map-work");
	assert.equal(correlateSkillRead("read", { path: "/opaque/a" }, snapshot), undefined);
});

test("typed capability resolution rejects stale or invented selection", () => {
	const snapshot = snapshotSkills(commands);
	assert.equal(validateCapabilityResolution({ snapshotSha256: snapshot.sha256, intent: "review", selectedName: "inspect-result" }, snapshot)?.name, "inspect-result");
	assert.equal(validateCapabilityResolution({ snapshotSha256: snapshot.sha256, intent: "review", selectedName: null }, snapshot), null);
	assert.throws(() => validateCapabilityResolution({ snapshotSha256: "stale", intent: "review", selectedName: null }, snapshot), /stale/);
	assert.throws(() => validateCapabilityResolution({ snapshotSha256: snapshot.sha256, intent: "review", selectedName: "missing" }, snapshot), /not present/);
});
