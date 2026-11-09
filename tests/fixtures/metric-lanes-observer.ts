import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probe, renderFooter } from "./metric-lanes.ts";

/** Loaded after work-timing, so its `message_end` runs after the request entry and before Pi persists the message. */
export default function metricLanesObserver(pi: ExtensionAPI): void {
	const state = probe();
	const tail = (entries: ReadonlyArray<{ type: string; customType?: string; message?: { role?: string } }>) =>
		entries.slice(-2).map((entry) => entry.type === "custom" ? `custom:${entry.customType}` : `${entry.type}:${entry.message?.role ?? ""}`);
	// Custom streamSimple transports expose no provider payload stage, so the assistant stream start marks the request.
	pi.on("message_start", (event, ctx) => {
		if ((event.message as { role?: string }).role !== "assistant") return;
		state.samples.push({ at: "request-start", footer: renderFooter(), tail: tail(ctx.sessionManager.getEntries() as never) });
	});
	pi.on("message_end", (event, ctx) => {
		if ((event.message as { role?: string }).role !== "assistant") return;
		state.samples.push({ at: "message-end", footer: renderFooter(), working: state.working, tail: tail(ctx.sessionManager.getEntries() as never) });
	});
	pi.on("turn_end", (_event, ctx) => {
		state.samples.push({ at: "turn-end", footer: renderFooter(), working: state.working, tail: tail(ctx.sessionManager.getEntries() as never) });
	});
}
