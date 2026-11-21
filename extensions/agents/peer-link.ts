/**
 * Child side of the peer link. Loaded by the managed child guard: it receives messages from the
 * invoking hub and places them in this agent's run as distinct custom messages (never user input),
 * and it carries this agent's own agent operations to the hub. A message that arrives after the
 * run settled, or that the run did not take before settling, goes back to the hub, which starts the
 * agent's next turn with it. Messages waiting when a turn starts arrive before its first model call;
 * a message this session already holds (a lost acknowledgement) is acknowledged rather than repeated.
 */
import { connect, type Socket } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_MESSAGE_TYPE, JsonLineReader, PEER_LINK_ENV, formatAgentMessage, type ChildFrame, type HubFrame, type PeerLinkBinding, type PeerOperation } from "./peer-protocol.ts";

export class PeerLinkError extends Error {
	constructor(readonly code: string, readonly detail?: string) { super(code); this.name = "PeerLinkError"; }
}

function readBinding(env: NodeJS.ProcessEnv): PeerLinkBinding | undefined {
	const raw = env[PEER_LINK_ENV];
	// Shell commands in this agent never see the link token.
	delete env[PEER_LINK_ENV];
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as Partial<PeerLinkBinding>;
		return typeof value.socket === "string" && typeof value.token === "string" ? { socket: value.socket, token: value.token, ...(value.wake === true ? { wake: true } : {}) } : undefined;
	} catch { return undefined; }
}

/** Upper bound on holding the first model call for messages waiting at attach time. */
const READY_WAIT_MS = 5_000;

export interface PeerLink { request(op: PeerOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string }> }

export function startPeerLink(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): PeerLink | undefined {
	const binding = readBinding(env);
	if (!binding) return undefined;
	let socket: Socket | undefined;
	let closed = false;
	let settled = false;
	let sequence = 0;
	const accepted = new Set<string>();
	const held = new Set<string>();
	let markReady!: (ok: boolean) => void;
	const ready = new Promise<boolean>(resolve => { markReady = resolve; });
	const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
	const send = (frame: ChildFrame) => { if (socket && !closed) socket.write(`${JSON.stringify(frame)}\n`); };
	const fail = () => {
		closed = true;
		markReady(false);
		for (const waiter of pending.values()) waiter.reject(new PeerLinkError("agent_link_closed"));
		pending.clear();
	};
	const onFrame = (raw: unknown) => {
		const frame = raw as HubFrame;
		if (frame?.type === "deliver" && typeof frame.id === "string" && typeof frame.text === "string") {
			if (held.has(frame.id)) { send({ type: "accepted", id: frame.id }); send({ type: "consumed", id: frame.id }); return; }
			if (settled) { send({ type: "rejected", id: frame.id }); return; }
			accepted.add(frame.id); held.add(frame.id);
			pi.sendMessage({ customType: AGENT_MESSAGE_TYPE, content: formatAgentMessage(frame.from, frame.kind, frame.text), display: true, details: { id: frame.id, kind: frame.kind, from: frame.from } }, { deliverAs: "steer" });
			send({ type: "accepted", id: frame.id });
		} else if (frame?.type === "ready") markReady(true);
		else if (frame?.type === "response" && typeof frame.id === "string") {
			const waiter = pending.get(frame.id); if (!waiter) return;
			pending.delete(frame.id);
			if (frame.ok) waiter.resolve(frame.result);
			else waiter.reject(new PeerLinkError(frame.error?.code ?? "agent_request_failed", frame.error?.detail));
		}
	};
	let attached = false;
	const attach = () => { if (attached) return; attached = true; try {
		socket = connect(binding.socket);
		socket.unref();
		socket.setEncoding("utf8");
		const reader = new JsonLineReader(onFrame, () => {});
		socket.on("data", (chunk: string) => reader.push(chunk));
		socket.on("error", fail);
		socket.on("close", fail);
		send({ type: "hello", token: binding.token });
	} catch { fail(); } };

	pi.on("session_start", (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; details?: { id?: unknown } }>) {
			if (entry.type === "custom_message" && entry.customType === AGENT_MESSAGE_TYPE && typeof entry.details?.id === "string") held.add(entry.details.id);
		}
		attach();
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		attach();
		// Pi counts as busy here, so messages delivered meanwhile join this run before its first model call.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ok = await Promise.race([ready, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), READY_WAIT_MS); })]);
		if (timer) clearTimeout(timer);
		// A turn started for waiting messages does not run without them; the hub reports the failed delivery.
		if (!ok && binding.wake) ctx.abort();
	});
	// A message counts as consumed once it is durable in this session; Pi persists custom messages
	// at their append, which precedes the next model request.
	const confirm = (entries: ReadonlyArray<{ type?: string; customType?: string; details?: { id?: unknown } }>) => {
		if (!accepted.size) return;
		for (const entry of entries) {
			const id = entry.type === "custom_message" && entry.customType === AGENT_MESSAGE_TYPE ? entry.details?.id : undefined;
			if (typeof id === "string" && accepted.delete(id)) send({ type: "consumed", id });
		}
	};
	pi.on("turn_start", (_event, ctx) => { confirm(ctx.sessionManager.getEntries() as never); send({ type: "turn" }); });
	pi.on("turn_end", (_event, ctx) => { confirm(ctx.sessionManager.getEntries() as never); });
	pi.on("agent_settled", (_event, ctx) => {
		confirm(ctx.sessionManager.getEntries() as never);
		settled = true;
		send({ type: "settled", unconsumed: [...accepted] });
		accepted.clear();
	});
	pi.on("session_shutdown", () => { socket?.end(); });
	return {
		request(op, args, signal) {
			const id = `r${++sequence}`;
			return new Promise<{ text: string }>((resolve, reject) => {
				if (closed || !socket) { reject(new PeerLinkError("agent_link_unavailable")); return; }
				// A waiting request keeps this agent's process alive until the hub answers.
				socket.ref();
				pending.set(id, { resolve: value => resolve(value as { text: string }), reject });
				signal?.addEventListener("abort", () => { if (pending.delete(id)) reject(new PeerLinkError("aborted")); }, { once: true });
				send({ type: "request", id, op, args });
			}).finally(() => { if (pending.size === 0) socket?.unref(); });
		},
	};
}
