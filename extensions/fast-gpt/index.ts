import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FAST_GPT_ENTRY_TYPE = "csheng-fast-gpt";

const FAST_GPT_STATE_VERSION = 1 as const;
const STATUS_KEY = "fast-gpt";
type FastGptSelection = "untouched" | "priority" | "default";
type SelectedServiceTier = Exclude<FastGptSelection, "untouched">;

interface PersistedFastGptState {
	version: typeof FAST_GPT_STATE_VERSION;
	selection: SelectedServiceTier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedState(value: unknown): SelectedServiceTier | undefined {
	if (!isRecord(value) || value.version !== FAST_GPT_STATE_VERSION) return undefined;
	return value.selection === "priority" || value.selection === "default"
		? value.selection
		: undefined;
}

function restoreBranchSelection(
	entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
): FastGptSelection | "invalid" {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== FAST_GPT_ENTRY_TYPE) continue;
		return parsePersistedState(entry.data) ?? "invalid";
	}
	return "untouched";
}

function supportsFastGpt(model: ExtensionContext["model"]): boolean {
	return model !== undefined && (
		(model.provider === "openai" && model.api === "openai-responses") ||
		(model.provider === "openai-codex" && model.api === "openai-codex-responses")
	);
}

export default function fastGptExtension(pi: ExtensionAPI): void {
	let selection: FastGptSelection = "untouched";

	function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
		const value = selection === "priority" && supportsFastGpt(model)
			? ctx.ui.theme.fg("warning", "fast-gpt")
			: undefined;
		ctx.ui.setStatus(STATUS_KEY, value);
	}

	function restoreActiveBranch(ctx: ExtensionContext): void {
		const restored = restoreBranchSelection(ctx.sessionManager.getBranch());
		if (restored === "invalid") {
			selection = "untouched";
			updateStatus(ctx);
			ctx.ui.notify("Invalid fast-gpt state was ignored; provider requests remain unchanged.", "warning");
			return;
		}
		selection = restored;
		updateStatus(ctx);
	}

	pi.registerCommand("fast-gpt", {
		description: "Toggle OpenAI Responses priority processing",
		handler: async (_args, ctx) => {
			selection = selection === "priority" ? "default" : "priority";
			const state: PersistedFastGptState = {
				version: FAST_GPT_STATE_VERSION,
				selection,
			};
			pi.appendEntry(FAST_GPT_ENTRY_TYPE, state);
			updateStatus(ctx);

			const mode = selection === "priority" ? "enabled" : "disabled";
			if (supportsFastGpt(ctx.model)) {
				ctx.ui.notify(`Fast GPT ${mode}.`, "info");
			} else {
				ctx.ui.notify(`Fast GPT ${mode}; the current model is not an official OpenAI Responses model.`, "warning");
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (
			selection === "untouched" ||
			!supportsFastGpt(ctx.model) ||
			!isRecord(event.payload) ||
			event.payload.model !== ctx.model?.id
		) return undefined;

		return { ...event.payload, service_tier: selection };
	});

	pi.on("session_start", async (_event, ctx) => restoreActiveBranch(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreActiveBranch(ctx));
	pi.on("model_select", async (event, ctx) => updateStatus(ctx, event.model));
}
