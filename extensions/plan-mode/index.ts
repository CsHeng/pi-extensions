import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_ENTRY_TYPE = "csheng-plan-mode";
export const PLAN_MODE_TOOLS = ["read", "grep", "find", "ls"] as const;

type Profile = "default" | "plan";

interface PlanModeState {
	profile: Profile;
	toolsBeforePlan: string[] | null;
}

const PLAN_INSTRUCTION = `[PLAN PROFILE ACTIVE]
Use the available read-only tools to inspect the workspace and surface uncertainty.
Return analysis or a plan without mutating files or running commands.`;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseState(value: unknown): PlanModeState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.profile === "default" && record.toolsBeforePlan === null) {
		return { profile: "default", toolsBeforePlan: null };
	}
	if (record.profile === "plan" && isStringArray(record.toolsBeforePlan)) {
		return { profile: "plan", toolsBeforePlan: [...record.toolsBeforePlan] };
	}
	return undefined;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let state: PlanModeState = { profile: "default", toolsBeforePlan: null };

	function updateStatus(ctx: ExtensionContext): void {
		const value = state.profile === "plan" ? ctx.ui.theme.fg("warning", "plan") : undefined;
		ctx.ui.setStatus("plan-mode", value);
	}

	function persistState(): void {
		pi.appendEntry(PLAN_MODE_ENTRY_TYPE, {
			profile: state.profile,
			toolsBeforePlan: state.toolsBeforePlan === null ? null : [...state.toolsBeforePlan],
		});
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

	function enterPlan(ctx: ExtensionContext, persist = true): void {
		if (state.profile === "plan") {
			applyPlanTools(ctx);
			updateStatus(ctx);
			return;
		}
		state = { profile: "plan", toolsBeforePlan: pi.getActiveTools() };
		const missing = applyPlanTools(ctx);
		updateStatus(ctx);
		if (persist) persistState();
		if (missing.length === 0) {
			ctx.ui.notify("Plan profile enabled. Workspace mutation tools are inactive.", "info");
		}
	}

	function enterDefault(ctx: ExtensionContext): void {
		if (state.profile === "default") {
			updateStatus(ctx);
			return;
		}
		const toolsToRestore = state.toolsBeforePlan ?? [];
		pi.setActiveTools([...toolsToRestore]);
		state = { profile: "default", toolsBeforePlan: null };
		updateStatus(ctx);
		persistState();
		ctx.ui.notify("Default profile restored.", "info");
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
		const entries = ctx.sessionManager.getEntries();
		let latestData: unknown;
		let hasLatest = false;
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === PLAN_MODE_ENTRY_TYPE) {
				latestData = entry.data;
				hasLatest = true;
			}
		}
		const restored = parseState(latestData);

		if (hasLatest && restored === undefined) {
			state = { profile: "plan", toolsBeforePlan: pi.getActiveTools() };
			applyPlanTools(ctx);
			updateStatus(ctx);
			persistState();
			ctx.ui.notify("Invalid plan-profile state was replaced with a fail-closed plan profile.", "error");
			return;
		}

		if (restored !== undefined) state = restored;
		if (pi.getFlag("plan") === true && state.profile !== "plan") {
			enterPlan(ctx);
			return;
		}
		if (state.profile === "plan") applyPlanTools(ctx);
		updateStatus(ctx);
	});
}
