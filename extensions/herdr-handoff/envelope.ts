import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	AGENT_OUTCOMES,
	HANDOFF_REQUEST_PROTOCOL,
	HANDOFF_RETURN_PROTOCOL,
	HARD_LIMITS,
	RETURN_END_SENTINEL,
	RETURN_START_SENTINEL,
	utf8Bytes,
	type AgentOutcome,
	type HandoffErrorCode,
	type HandoffMode,
	type HandoffPlan,
	type HandoffRequest,
	type RecipientReturnEnvelope,
	type RecipientVerificationRecord,
} from "./contracts.ts";

export interface CanonicalPlan {
	text: string;
	planSha256: string;
}

export interface HandoffPrompt {
	handoffId: string;
	planSha256: string;
	prompt: string;
}

export type EnvelopeFailure = { ok: false; code: HandoffErrorCode; message: string };
export type PlanResult = { ok: true; plan: CanonicalPlan } | EnvelopeFailure;
export type PromptResult = { ok: true; prompt: HandoffPrompt } | EnvelopeFailure;
export type ReturnParseResult = { ok: true; envelope: RecipientReturnEnvelope } | EnvelopeFailure;

const PLAN_TOO_LARGE = "Canonical plan exceeds the size ceiling.";
const REQUEST_INVALID = "Handoff request is invalid.";
const PLAN_OUTSIDE = "Plan file is outside the repository.";
const MALFORMED = "Recipient return envelope is malformed.";
const ID_MISMATCH = "Recipient return envelope handoff ID does not match.";

export function createHandoffId(): string {
	return randomUUID();
}

export function hashUtf8(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function contains(root: string, target: string): boolean {
	const relation = relative(root, target);
	return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function isRepoRelative(path: string): boolean {
	return path.length > 0
		&& !path.includes("\0")
		&& !isAbsolute(path)
		&& !path.split(/[\\/]/).some((part) => part === "..");
}

async function assertNoSymlinkComponent(root: string, target: string): Promise<void> {
	let current = root;
	const relation = relative(root, target);
	if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("escape");
	for (const component of relation.split(sep)) {
		if (!component) continue;
		current = join(current, component);
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return;
			throw error;
		}
	}
}

export async function readCanonicalPlan(gitRoot: string, plan: HandoffPlan): Promise<PlanResult> {
	if (plan.source === "inline") {
		if (utf8Bytes(plan.text) > HARD_LIMITS.maxPlanBytes) {
			return { ok: false, code: "plan_too_large", message: PLAN_TOO_LARGE };
		}
		return { ok: true, plan: { text: plan.text, planSha256: hashUtf8(plan.text) } };
	}
	if (!isRepoRelative(plan.path)) {
		return { ok: false, code: "plan_outside_repository", message: PLAN_OUTSIDE };
	}
	try {
		const root = await realpath(gitRoot);
		const target = resolve(root, plan.path);
		if (!contains(root, target)) {
			return { ok: false, code: "plan_outside_repository", message: PLAN_OUTSIDE };
		}
		await assertNoSymlinkComponent(root, target);
		const info = await lstat(target);
		if (info.isSymbolicLink() || !info.isFile()) {
			return { ok: false, code: "plan_outside_repository", message: PLAN_OUTSIDE };
		}
		const physical = await realpath(target);
		if (!contains(root, physical)) {
			return { ok: false, code: "plan_outside_repository", message: PLAN_OUTSIDE };
		}
		const text = await readFile(target, "utf8");
		if (utf8Bytes(text) > HARD_LIMITS.maxPlanBytes) {
			return { ok: false, code: "plan_too_large", message: PLAN_TOO_LARGE };
		}
		return { ok: true, plan: { text, planSha256: hashUtf8(text) } };
	} catch {
		return { ok: false, code: "plan_outside_repository", message: PLAN_OUTSIDE };
	}
}

function line(label: string, value: string): string {
	return `${label}\n${value}`;
}

function bulletList(items: readonly string[]): string {
	return items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");
}

export function buildHandoffPrompt(input: {
	handoffId: string;
	mode: HandoffMode;
	request: HandoffRequest;
	canonicalPlan: CanonicalPlan;
}): PromptResult {
	if (utf8Bytes(input.request.objective) > HARD_LIMITS.maxObjectiveBytes) {
		return { ok: false, code: "invalid_handoff_request", message: REQUEST_INVALID };
	}
	if (utf8Bytes(input.canonicalPlan.text) > HARD_LIMITS.maxPlanBytes) {
		return { ok: false, code: "plan_too_large", message: PLAN_TOO_LARGE };
	}
	const context = input.request.context ?? [];
	const prompt = [
		`protocol: ${HANDOFF_REQUEST_PROTOCOL}`,
		`handoff_id: ${input.handoffId}`,
		`mode: ${input.mode}`,
		`plan_sha256: ${input.canonicalPlan.planSha256}`,
		"repository: .",
		"",
		"AUTHORITY",
		"- Create or modify only allowedWrites regular files.",
		"- Do not delete, rename, stage, commit, push, install, publish, deploy, authenticate, change credentials, modify another checkout, or act on an external system.",
		"- Do not redesign or widen scope.",
		"- Stop with needs_authority when the plan is insufficient.",
		"- Run requested verification where possible, but report evidence as a claim.",
		`- Emit exactly one ${HANDOFF_RETURN_PROTOCOL} object between ${RETURN_START_SENTINEL} and ${RETURN_END_SENTINEL} at the end of the final response.`,
		"- Pretty-print the return JSON and keep every physical output line under 96 columns so terminal rendering does not split JSON strings.",
		"",
		line("OBJECTIVE", input.request.objective),
		"",
		line("CANONICAL PLAN", input.canonicalPlan.text),
		"",
		line("ALLOWED WRITES", bulletList(input.request.allowedWrites)),
		"",
		line("NON-GOALS", bulletList(input.request.nonGoals)),
		"",
		line("VERIFICATION EXPECTATIONS", bulletList(input.request.verification)),
		"",
		line("CONTEXT", bulletList(context)),
		"",
		"RETURN OBJECT FIELDS",
		`- protocol: ${HANDOFF_RETURN_PROTOCOL}`,
		"- handoff_id: exact correlation ID",
		"- outcome: implemented | no_changes | blocked | needs_authority | failed",
		"- summary: bounded text",
		"- changed_paths: repository-relative files",
		"- verification: [{check, status: passed|failed|not_run, evidence}]",
		"- questions: bounded strings",
		"- risks: bounded strings",
	].join("\n");
	if (utf8Bytes(prompt) > HARD_LIMITS.maxPromptBytes) {
		return { ok: false, code: "invalid_handoff_request", message: REQUEST_INVALID };
	}
	return {
		ok: true,
		prompt: {
			handoffId: input.handoffId,
			planSha256: input.canonicalPlan.planSha256,
			prompt,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, maxItems: number, maxBytes: number): string[] | undefined {
	if (!Array.isArray(value) || value.length > maxItems) return undefined;
	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.length < 1 || utf8Bytes(item) > maxBytes) return undefined;
		items.push(item);
	}
	return items;
}

function parseChangedPaths(value: unknown): string[] | undefined {
	const items = parseStringArray(value, HARD_LIMITS.maxWritePaths, 4096);
	if (!items) return undefined;
	if (items.some((item) => !isRepoRelative(item))) return undefined;
	return items;
}

function parseVerification(value: unknown): RecipientVerificationRecord[] | undefined {
	if (!Array.isArray(value) || value.length > HARD_LIMITS.maxVerificationEntries) return undefined;
	const records: RecipientVerificationRecord[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) return undefined;
		if (Object.keys(entry).some((key) => !["check", "status", "evidence"].includes(key))) return undefined;
		if (typeof entry.check !== "string" || entry.check.length < 1 || utf8Bytes(entry.check) > HARD_LIMITS.maxEvidenceBytes) return undefined;
		if (entry.status !== "passed" && entry.status !== "failed" && entry.status !== "not_run") return undefined;
		if (typeof entry.evidence !== "string" || utf8Bytes(entry.evidence) > HARD_LIMITS.maxEvidenceBytes) return undefined;
		records.push({ check: entry.check, status: entry.status, evidence: entry.evidence });
	}
	return records;
}

function capReturnText(text: string): string {
	const lines = text.split("\n");
	const limited = lines.length > HARD_LIMITS.maxReturnLines
		? lines.slice(-HARD_LIMITS.maxReturnLines).join("\n")
		: text;
	if (utf8Bytes(limited) <= HARD_LIMITS.maxReturnEnvelopeBytes) return limited;
	let low = 0;
	let high = limited.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (utf8Bytes(limited.slice(-middle)) <= HARD_LIMITS.maxReturnEnvelopeBytes) low = middle;
		else high = middle - 1;
	}
	return limited.slice(-low);
}

function sentinelCandidates(text: string): { candidates: unknown[]; malformed: boolean } {
	const candidates: unknown[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf(RETURN_START_SENTINEL, cursor);
		const end = text.indexOf(RETURN_END_SENTINEL, cursor);
		if (start < 0 && end < 0) break;
		if (start < 0 || end < start) return { candidates, malformed: true };
		const bodyStart = start + RETURN_START_SENTINEL.length;
		const bodyEnd = text.indexOf(RETURN_END_SENTINEL, bodyStart);
		if (bodyEnd < 0) return { candidates, malformed: true };
		const body = text.slice(bodyStart, bodyEnd);
		if (body.includes(RETURN_START_SENTINEL)) return { candidates, malformed: true };
		try {
			candidates.push(JSON.parse(body.trim()) as unknown);
		} catch {
			candidates.push(undefined);
		}
		cursor = bodyEnd + RETURN_END_SENTINEL.length;
	}
	return { candidates, malformed: false };
}

export function parseRecipientReturn(text: string, handoffId: string): ReturnParseResult {
	const scan = sentinelCandidates(capReturnText(text));
	if (scan.malformed) return { ok: false, code: "malformed_return", message: MALFORMED };
	const { candidates } = scan;
	const matching = candidates
		.map((candidate, index) => ({ candidate, index }))
		.filter(({ candidate }) => isRecord(candidate)
			&& candidate.protocol === HANDOFF_RETURN_PROTOCOL
			&& candidate.handoff_id === handoffId);
	if (matching.length !== 1 || matching[0]?.index !== candidates.length - 1) {
		const finalCandidate = candidates.at(-1);
		const finalMismatch = isRecord(finalCandidate)
			&& finalCandidate.protocol === HANDOFF_RETURN_PROTOCOL
			&& typeof finalCandidate.handoff_id === "string";
		return matching.length === 0 && finalMismatch
			? { ok: false, code: "return_id_mismatch", message: ID_MISMATCH }
			: { ok: false, code: "malformed_return", message: MALFORMED };
	}
	const parsed = matching[0].candidate;
	if (!isRecord(parsed)) return { ok: false, code: "malformed_return", message: MALFORMED };
	if (Object.keys(parsed).some((key) => ![
		"protocol", "handoff_id", "outcome", "summary", "changed_paths", "verification", "questions", "risks",
	].includes(key))) {
		return { ok: false, code: "malformed_return", message: MALFORMED };
	}
	if (parsed.protocol !== HANDOFF_RETURN_PROTOCOL) {
		return { ok: false, code: "malformed_return", message: MALFORMED };
	}
	if (parsed.handoff_id !== handoffId) {
		return { ok: false, code: "return_id_mismatch", message: ID_MISMATCH };
	}
	if (typeof parsed.outcome !== "string" || !(AGENT_OUTCOMES as readonly string[]).includes(parsed.outcome)) {
		return { ok: false, code: "malformed_return", message: MALFORMED };
	}
	if (typeof parsed.summary !== "string" || utf8Bytes(parsed.summary) > HARD_LIMITS.maxSummaryBytes) {
		return { ok: false, code: "malformed_return", message: MALFORMED };
	}
	const changedPaths = parseChangedPaths(parsed.changed_paths);
	const verification = parseVerification(parsed.verification);
	const questions = parseStringArray(parsed.questions, HARD_LIMITS.maxQuestions, HARD_LIMITS.maxSummaryBytes);
	const risks = parseStringArray(parsed.risks, HARD_LIMITS.maxRisks, HARD_LIMITS.maxSummaryBytes);
	if (!changedPaths || !verification || !questions || !risks) {
		return { ok: false, code: "malformed_return", message: MALFORMED };
	}
	return {
		ok: true,
		envelope: {
			protocol: HANDOFF_RETURN_PROTOCOL,
			handoff_id: handoffId,
			outcome: parsed.outcome as AgentOutcome,
			summary: parsed.summary,
			changed_paths: changedPaths,
			verification,
			questions,
			risks,
		},
	};
}
