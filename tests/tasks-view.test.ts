import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import workflow from "../extensions/tasklist/index.ts";
import { createTasklistStore } from "../extensions/tasklist/goal-store.ts";
import { registerTasksView, TASKS_VIEW_CHANGED_EVENT, TASKS_VIEW_EVENT, TASKS_VIEW_REQUEST_EVENT, TASKS_VIEW_RESET_EVENT, TASKS_VIEW_VERSION, parseTasksViewReply } from "../extensions/tasklist/tasks-view.ts";

function harness() {
 const listeners = new Map<string, Array<(data: unknown) => void>>();
 const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
 const tools: string[] = [];
 const appended: string[] = [];
 const wakes: string[] = [];
 const contexts: string[] = [];
 const events = { on(name: string, fn: (data: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
  emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); } };
 const pi = { registerCommand() {}, registerTool(tool: { name: string }) { tools.push(tool.name); }, getActiveTools: () => tools, appendEntry(type: string) { appended.push(type); }, sendUserMessage(text: string) { wakes.push(text); },
  on(name: string, fn: (event: unknown, ctx: ExtensionContext) => void) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); if (name === "context") contexts.push(name); }, events } as unknown as ExtensionAPI;
 const ctx = { mode: "tui", hasUI: true, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session-a", getLeafId: () => "leaf-a", getBranch: () => [{ id: "leaf-a" }] }, ui: { setWidget() {} } } as unknown as ExtensionContext;
 return { pi, ctx, listeners, handlers, tools, appended, wakes, contexts, events };
}
function request(events: { emit: (name: string, data: unknown) => void }, listeners: Map<string, Array<(data: unknown) => void>>, requestId = "query-1") {
 let reply: unknown;
 const stop = events.emit;
 listeners.set(TASKS_VIEW_EVENT, [...(listeners.get(TASKS_VIEW_EVENT) ?? []), data => { reply = data; }]);
 stop(TASKS_VIEW_REQUEST_EVENT, { version: TASKS_VIEW_VERSION, requestId });
 return reply;
}

test("query reads the committed snapshot and does not mutate, append, wake, or enter context", () => {
 const h = harness();
 const store = createTasklistStore(type => h.appended.push(type));
 const view = registerTasksView(h.pi, store);
 view.bind(h.ctx);
 const changed: unknown[] = [];
 h.listeners.set(TASKS_VIEW_CHANGED_EVENT, [data => changed.push(data)]);
 store.mutate({ operation: "set", title: "Fixture", tasks: [{ id: "a", title: "Task" }] });
 const seen = request(h.events, h.listeners);
 const parsed = parseTasksViewReply(seen);
 assert.equal(parsed.ok, true);
 if (!parsed.ok) return;
 assert.equal(parsed.value.state?.revision, store.current()!.revision);
 assert.equal(parsed.value.state?.title, "Fixture");
 assert.equal(parsed.value.state?.tasks[0]?.title, "Task");
 assert.equal(JSON.stringify(changed).includes("Task"), false);
 assert.equal(JSON.stringify(seen).includes("observation"), false);
 assert.equal(JSON.stringify(seen).includes("paused"), false);
 const before = store.current()!.revision;
 const appends = h.appended.length;
 request(h.events, h.listeners, "query-2");
 assert.equal(store.current()!.revision, before);
 assert.equal(h.appended.length, appends);
 assert.deepEqual(h.wakes, []);
 assert.deepEqual(h.contexts, []);
 assert.equal(store.current()!.tasks[0]!.status, "todo");
 view.unbind();
});
test("invalidation is emitted only after the owner commit and late queries see it", () => {
 const h = harness();
 const store = createTasklistStore(() => {});
 const view = registerTasksView(h.pi, store);
 const duringHold: unknown[] = [];
 h.events.on(TASKS_VIEW_CHANGED_EVENT, data => duringHold.push(data));
 view.hold();
 store.mutate({ operation: "set", title: "Hidden", tasks: [{ id: "a", title: "Early" }] });
 assert.deepEqual(duringHold, []);
 view.bind(h.ctx);
 assert.equal(duringHold.length > 0, true);
 let revision = 0;
 h.events.on(TASKS_VIEW_CHANGED_EVENT, () => {
  const parsed = parseTasksViewReply(request(h.events, h.listeners, "late"));
  if (parsed.ok) revision = parsed.value.state?.revision ?? 0;
 });
 store.mutate({ operation: "update", tasks: [{ id: "a", status: "doing" }] });
 assert.equal(revision, store.current()!.revision);
 assert.equal(store.current()!.tasks[0]!.status, "doing");
 view.unbind();
});
test("untrusted and unsupported owners publish unavailable without task payloads", () => {
 const h = harness();
 const store = createTasklistStore(() => {});
 const view = registerTasksView(h.pi, store);
 store.mutate({ operation: "set", title: "Secret", tasks: [{ id: "a", title: "Hidden" }] });
 const untrusted = { ...h.ctx, isProjectTrusted: () => false } as ExtensionContext;
 view.bind(untrusted);
 const denied = parseTasksViewReply(request(h.events, h.listeners, "deny"));
 assert.equal(denied.ok && denied.value.availability, "unavailable");
 assert.equal(denied.ok && denied.value.reason, "untrusted");
 assert.equal(denied.ok && denied.value.state, undefined);
 assert.equal(JSON.stringify(denied).includes("Hidden"), false);
 view.bind(h.ctx);
 store.replay([{ type: "custom", customType: "csheng-workflow-state", data: { schemaVersion: 2, state: { goal: "old" } } }]);
 const ignored = parseTasksViewReply(request(h.events, h.listeners, "query-history"));
 assert.equal(ignored.ok && ignored.value.availability, "unavailable");
 assert.equal(ignored.ok && ignored.value.reason, "unsupported");
 assert.equal(ignored.ok && ignored.value.state, undefined);
 assert.equal(JSON.stringify(ignored).includes("goal"), false);
 view.unbind();
});
test("malformed requests are ignored and headless workflow keeps its tool", () => {
 const h = harness();
 const tools: string[] = [];
 const widgets: unknown[] = [];
 const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
 const pi = { registerCommand() {}, registerTool(tool: { name: string }) { tools.push(tool.name); }, getActiveTools: () => tools, appendEntry() {}, sendUserMessage() { throw new Error("wake"); },
  on(name: string, fn: (event: unknown, ctx: ExtensionContext) => void) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, events: h.events } as unknown as ExtensionAPI;
 workflow(pi);
 const ctx = { mode: "print", hasUI: true, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "session-a", getLeafId: () => null, getBranch: () => [] }, ui: { setWidget() { widgets.push("mounted"); } } } as unknown as ExtensionContext;
 for (const fn of handlers.get("session_start") ?? []) fn({}, ctx);
 let replies = 0;
 h.events.on(TASKS_VIEW_EVENT, () => { replies += 1; });
 h.events.emit(TASKS_VIEW_REQUEST_EVENT, { version: TASKS_VIEW_VERSION, requestId: "ok" });
 h.events.emit(TASKS_VIEW_REQUEST_EVENT, { version: 9, requestId: "bad" });
 assert.equal(replies, 1);
 assert.equal(tools.includes("tasklist"), true);
 assert.equal(tools.includes("csheng_workflow"), false);
 assert.deepEqual(widgets, []);
});
