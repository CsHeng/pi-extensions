import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSettlementBarrier } from "../extensions/shared/settlement.ts";

function fixture() {
 const hooks = new Map<string, Function>(); const commands = new Map<string, { handler: Function }>();
 const controller = new AbortController(); const messages: string[] = [];
 let enabled = false, idle = false, pending = false, release!: () => void, waiter: Promise<void> | undefined;
 const settled = new Promise<void>(resolve => { release = resolve; });
 const ctx = { mode: "rpc", signal: controller.signal, isIdle: () => idle, isProjectTrusted: () => true,
  hasPendingMessages: () => pending, sessionManager: { getSessionId: () => "fixture" }, waitForIdle: () => settled };
 const pi = { on: (name: string, fn: Function) => hooks.set(name, fn), registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
  getActiveTools: () => ["fixture"], sendUserMessage(message: string) {
   messages.push(message); const [name, token] = message.slice(1).split(" "); waiter = commands.get(name!)!.handler(token, ctx);
  } };
 const barrier = registerSettlementBarrier(pi as unknown as ExtensionAPI, { command: "fixture-wait", tool: "fixture", enabled: () => enabled });
 return { barrier, messages, hooks, controller, enable: () => { enabled = true; },
  start: () => hooks.get("agent_start")!({}, ctx as unknown as ExtensionContext),
  settle: async (hasPending = false) => { pending = hasPending; idle = true; release(); await waiter; },
 };
}

test("settlement wait is lazy, arms once for mid-run enrollment and dispatches only after idle", async () => {
 const f = fixture(); f.start(); assert.equal(f.messages.length, 0); assert.equal(f.barrier.arm(), false);
 f.enable(); assert.equal(f.barrier.arm(), true); assert.equal(f.barrier.arm(), true); assert.equal(f.messages.length, 1);
 let calls = 0; assert.equal(f.barrier.schedule(() => { calls++; }), true); assert.equal(calls, 0);
 await f.settle(); assert.equal(calls, 1); assert.equal(f.barrier.arm(), false);
});

for (const fence of ["input", "abort", "session_tree", "pending"] as const) test(`lazy settlement respects ${fence} fence`, async () => {
 const f = fixture(); f.enable(); f.start(); let calls = 0; assert.equal(f.barrier.schedule(() => { calls++; }), true);
 if (fence === "input") f.hooks.get("input")!({ source: "rpc" });
 else if (fence === "abort") f.controller.abort();
 else if (fence === "session_tree") f.hooks.get("session_tree")!();
 await f.settle(fence === "pending"); assert.equal(calls, 0);
});
