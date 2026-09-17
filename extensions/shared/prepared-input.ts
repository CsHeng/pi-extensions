import { createHash } from "node:crypto";
import type { ContextEvent, InputSource } from "@earendil-works/pi-coding-agent";
type AgentMessage = ContextEvent["messages"][number];

export type InputProvenance = "human" | "extension" | "unknown";
export interface PreparedInput { id: number; provenance: InputProvenance }
interface Pending extends PreparedInput { fingerprint: string }

/** Public-event observer, not a receipt-to-queue identity guesser.
 * Native message_start supplies occurrences; context commits participation. A structural digest
 * checks native-event membership in Pi's cloned context, never matches receipt text or origin.
 * Arbitrary context transformers can make identical copies indistinguishable; this observes
 * preparation at this hook, not final wire transmission after other extensions rewrite context.
 * Pi also has no input-handled completion event. Mixed receipts from abandoned or overlapping
 * prompts remain unknown; last-receipt-wins would incorrectly grant human credit on reordering.
 */
export function createPreparedInputTracker() {
	let sources = new Set<InputProvenance>();
	let prepared: InputProvenance[] = [];
	let pending: Pending[] = [];
	let seen = new WeakSet<object>();
	let serial = 0;
	let overflow = false;
	const fingerprint = (message: AgentMessage) => createHash("sha256").update(JSON.stringify(message)).digest("hex");
	return {
		received(event: { source: InputSource; streamingBehavior?: "steer" | "followUp" }) {
			// Queued receipts may be edited/withdrawn. They confer no context participation.
			if (event.streamingBehavior !== undefined) return;
			sources.add(event.source === "interactive" || event.source === "rpc" ? "human" : event.source === "extension" ? "extension" : "unknown");
		},
		prepare() {
			const source = sources.size === 1 ? [...sources][0]! : "unknown";
			// Concurrent ordinary preparations cannot be bound individually through public events.
			prepared = prepared.length ? ["unknown"] : [source];
			sources.clear();
		},
		observe(message: AgentMessage) {
			if (message.role !== "user" || seen.has(message)) return;
			seen.add(message);
			const provenance = prepared[0] ?? "unknown";
			prepared = [];
			if (pending.length >= 64) { overflow = true; return; }
			pending.push({ id: ++serial, provenance, fingerprint: fingerprint(message) });
		},
		peek(messages: readonly AgentMessage[]): PreparedInput[] {
			if (overflow) throw new Error("prepared_input_limit: too many uncommitted native input occurrences");
			const counts = new Map<string, number>();
			for (const message of messages) if (message.role === "user") {
				const key = fingerprint(message);
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
			const result: PreparedInput[] = [];
			for (const item of pending) {
				const count = counts.get(item.fingerprint) ?? 0;
				if (!count) continue;
				counts.set(item.fingerprint, count - 1);
				result.push({ id: item.id, provenance: item.provenance });
			}
			return result;
		},
		commit(ids: readonly number[]) {
			const consumed = new Set(ids);
			pending = pending.filter((item) => !consumed.has(item.id));
		},
		reset() {
			sources = new Set(); prepared = []; pending = []; seen = new WeakSet(); overflow = false;
			// Do not reuse occurrence IDs within this observer's lifetime.
		},
	};
}
export type PreparedInputTracker = ReturnType<typeof createPreparedInputTracker>;
