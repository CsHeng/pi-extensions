import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_ENTRY_TYPE = "csheng-plan-mode";
export const PLAN_MODE_TOOLS = ["read", "grep", "find", "ls"] as const;

const PLAN_MODE_STATE_VERSION = 2 as const;
type Profile = "default" | "plan";

interface PlanModeState {
	profile: Profile;
	restoreTools: string[];
}

interface PersistedPlanModeState extends PlanModeState {
	version: typeof PLAN_MODE_STATE_VERSION;
}

const PLAN_INSTRUCTION = `[PLAN PROFILE ACTIVE]
Use the available read-only tools to inspect the workspace and surface uncertainty.
Return analysis or a plan without mutating files or running commands.`;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseCurrentState(value: unknown): PlanModeState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== PLAN_MODE_STATE_VERSION ||
		(record.profile !== "default" && record.profile !== "plan") ||
		!isStringArray(record.restoreTools)
	) return undefined;
	return { profile: record.profile, restoreTools: [...record.restoreTools] };
}

function parseLegacyPlanState(value: unknown): PlanModeState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.profile !== "plan" || !isStringArray(record.toolsBeforePlan)) return undefined;
	return { profile: "plan", restoreTools: [...record.toolsBeforePlan] };
}

function isLegacyDefaultState(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record.profile === "default" && record.toolsBeforePlan === null;
}

function restoredBranchState(entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, baselineTools: readonly string[]): PlanModeState | "invalid" {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== PLAN_MODE_ENTRY_TYPE) continue;
		const current = parseCurrentState(entry.data);
		if (current) return current;
		const legacyPlan = parseLegacyPlanState(entry.data);
		if (legacyPlan) return legacyPlan;
		if (!isLegacyDefaultState(entry.data)) return "invalid";

		for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
			const previous = entries[previousIndex];
			if (previous?.type !== "custom" || previous.customType !== PLAN_MODE_ENTRY_TYPE) continue;
			const previousCurrent = parseCurrentState(previous.data);
			if (previousCurrent?.profile === "plan") {
				return { profile: "default", restoreTools: [...previousCurrent.restoreTools] };
			}
			const previousLegacy = parseLegacyPlanState(previous.data);
			if (previousLegacy) return { profile: "default", restoreTools: [...previousLegacy.restoreTools] };
		}
		return { profile: "default", restoreTools: [...baselineTools] };
	}
	return { profile: "default", restoreTools: [...baselineTools] };
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let state: PlanModeState = { profile: "default", restoreTools: [] };
	let startupBaselineTools: string[] | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		const value = state.profile === "plan" ? ctx.ui.theme.fg("warning", "plan") : undefined;
		ctx.ui.setStatus("plan-mode", value);
	}

	function persistState(): void {
		const persisted: PersistedPlanModeState = {
			version: PLAN_MODE_STATE_VERSION,
			profile: state.profile,
			restoreTools: [...state.restoreTools],
		};
		pi.appendEntry(PLAN_MODE_ENTRY_TYPE, persisted);
	}

	function applyPlanTools(ctx: ExtensionContext): string[] {
		const available = new Set(
			pi.getAllTools()
				.filter((tool) => tool.sourceInfo.source === "builtin")
				.map((tool) => tool.name),
		);
		const selected = PLAN_MODE_TOOLS.filter((name) => available.has(name));
		const missing = PLAN_MODE_TOOLS.filter((name) => !available.has(name));
		pi.setActiveTools([...selected]);
		if (missing.length > 0) {
			ctx.ui.notify(`Plan profile is active but missing read-only tools: ${missing.join(", ")}.`, "error");
		}
		return missing;
	}

	function applyState(ctx: ExtensionContext): string[] {
		if (state.profile === "plan") return applyPlanTools(ctx);
		pi.setActiveTools([...state.restoreTools]);
		return [];
	}

	function enterPlan(ctx: ExtensionContext): void {
		if (state.profile === "plan") {
			applyPlanTools(ctx);
			updateStatus(ctx);
			return;
		}
		state = { profile: "plan", restoreTools: pi.getActiveTools() };
		const missing = applyPlanTools(ctx);
		updateStatus(ctx);
		persistState();
		if (missing.length === 0) {
			ctx.ui.notify("Plan profile enabled. Workspace mutation tools are inactive.", "info");
		}
	}

	function enterDefault(ctx: ExtensionContext): void {
		if (state.profile === "default") {
			applyState(ctx);
			updateStatus(ctx);
			return;
		}
		const restoreTools = [...state.restoreTools];
		pi.setActiveTools(restoreTools);
		state = { profile: "default", restoreTools };
		updateStatus(ctx);
		persistState();
		ctx.ui.notify("Default profile restored.", "info");
	}

	function restoreActiveBranch(ctx: ExtensionContext, applyStartupFlag: boolean): void {
		const baselineTools = startupBaselineTools ?? pi.getActiveTools();
		const restored = restoredBranchState(ctx.sessionManager.getBranch(), baselineTools);
		if (restored === "invalid") {
			state = { profile: "plan", restoreTools: [...baselineTools] };
			applyPlanTools(ctx);
			updateStatus(ctx);
			persistState();
			ctx.ui.notify("Invalid plan-profile state was replaced with a fail-closed plan profile.", "error");
			return;
		}

		state = restored;
		applyState(ctx);
		if (applyStartupFlag && pi.getFlag("plan") === true && state.profile !== "plan") {
			enterPlan(ctx);
			return;
		}
		updateStatus(ctx);
	}

	pi.registerFlag("plan", {
		description: "Start with the read-only plan profile",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Enter the read-only plan profile",
		handler: async (_args, ctx) => enterPlan(ctx),
	});

	pi.registerCommand("default", {
		description: "Restore the tool set active before plan profile",
		handler: async (_args, ctx) => enterDefault(ctx),
	});

	pi.on("before_agent_start", async (event) => {
		if (state.profile !== "plan") return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_INSTRUCTION}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		startupBaselineTools = pi.getActiveTools();
		restoreActiveBranch(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreActiveBranch(ctx, false);
	});
}
