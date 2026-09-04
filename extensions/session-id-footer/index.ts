import {
	FooterComponent,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface FooterState {
	model: ExtensionContext["model"];
	thinkingLevel: ExtensionContext["thinkingLevel"];
}

interface ActiveFooter {
	state: FooterState;
	requestRender?: () => void;
}

export function addSessionIdToFooterLine(
	line: string,
	sessionId: string,
	width: number,
	style: (text: string) => string = (text) => text,
): string {
	if (width <= 0) return "";

	const label = `session: ${sessionId}`;
	const suffix = ` • ${label}`;
	const suffixWidth = visibleWidth(suffix);
	const ellipsis = style("...");

	if (suffixWidth >= width) {
		return truncateToWidth(style(label), width, ellipsis);
	}

	const availableLineWidth = width - suffixWidth;
	return truncateToWidth(line, availableLineWidth, ellipsis) + style(suffix);
}

function createFooterSession(
	ctx: ExtensionContext,
	state: FooterState,
): AgentSession {
	const session = {
		get state() {
			return state;
		},
		sessionManager: ctx.sessionManager,
		getContextUsage: () => ctx.getContextUsage(),
		modelRuntime: {
			isUsingSubscription: (provider: string) => {
				const model = state.model;
				const providerAuth = ctx.modelRegistry.getProvider(provider)?.auth;
				return (
					model?.provider === provider &&
					ctx.modelRegistry.isUsingOAuth(model) &&
					providerAuth?.oauth?.isSubscription === true
				);
			},
		},
	};

	return session as unknown as AgentSession;
}

export default function sessionIdFooter(pi: ExtensionAPI): void {
	let activeFooter: ActiveFooter | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const active: ActiveFooter = {
			state: {
				model: ctx.model,
				thinkingLevel: ctx.thinkingLevel,
			},
		};
		activeFooter = active;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const footer = new FooterComponent(
				createFooterSession(ctx, active.state),
				footerData,
			);
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			active.requestRender = () => tui.requestRender();

			return {
				render(width: number): string[] {
					const lines = footer.render(width);
					const firstLine = lines[0] ?? "";
					lines[0] = addSessionIdToFooterLine(
						firstLine,
						ctx.sessionManager.getSessionId(),
						width,
						(text) => theme.fg("dim", text),
					);
					return lines;
				},
				invalidate(): void {
					footer.invalidate();
				},
				dispose(): void {
					unsubscribe();
					footer.dispose();
					if (activeFooter === active) activeFooter = undefined;
				},
			};
		});
	});

	pi.on("model_select", (event) => {
		if (!activeFooter) return;
		activeFooter.state.model = event.model;
		activeFooter.requestRender?.();
	});

	pi.on("thinking_level_select", (event) => {
		if (!activeFooter) return;
		activeFooter.state.thinkingLevel = event.level;
		activeFooter.requestRender?.();
	});
}
