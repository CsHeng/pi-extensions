import { createHash } from "node:crypto";
import type { DispatchEpoch } from "./managed-dispatch.ts";
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
export interface AsyncDispatchMetrics {
 receipts: number; runs: number; terminalRuns: number; terminalTasks: number; duplicateEvents: number; conflictingEvents: number; copiedEvents: number; invalidEvents: number; excludedTasks: number;
 launchedChildren: { known: number; unavailableTasks: number };
 timing: { preparationMs: number | null; queueMs: number | null; workspaceMs: number | null; childEffortMs: number | null; submissionToTerminalMs: number | null };
}
/** V3 receipts count admission only. Child execution is owned by persisted terminal facts. */
export class AsyncDispatchCollector {
 private receipts = 0; private runs = new Set<string>(); private terminals = new Map<string, Record<string, unknown>>();
 private events = new Map<string, string>(); private tasks = new Map<string, { view: Record<string, unknown>; timing?: Record<string, unknown> }>();
 private duplicate = 0; private conflicts = 0; private copied = 0; private invalid = 0;
 receipt(details: Record<string, unknown>) { if (details.kind === "submission" && details.status === "accepted" && id(details.runId)) { this.receipts++; this.runs.add(details.runId); } }
 event(raw: unknown, owner: unknown) {
  const event = object(raw); if (!event || event.version !== 3 || !id(event.eventId) || !id(event.runId) || !["task-terminal", "run-terminal"].includes(String(event.kind)) || !Array.isArray(event.sessions) || event.sessions.length > 10) { this.invalid++; return; }
  if (object(event.owner)?.sessionId !== owner) { this.copied++; return; }
  const key = `${owner}:${event.eventId}`, sig = signature(event); const prior = this.events.get(key);
  if (prior) { if (prior === sig) this.duplicate++; else this.conflicts++; return; }
  if (this.events.size >= 100000) throw new Error("too_many_runs"); this.events.set(key, sig);
  this.runs.add(event.runId);
  if (event.kind === "run-terminal") this.terminals.set(`${owner}:${event.runId}`, event);
  for (const rawView of event.sessions) {
   const view = object(rawView); if (!view || !id(view.handle) || !Number.isSafeInteger(view.episode) || (view.episode as number) < 1 || !object(view.result) || ["queued", "running"].includes(String(view.state))) { this.invalid++; continue; }
   const taskKey = `${owner}:${view.handle}:${view.episode}`;
   const timing = event.kind === "task-terminal" ? object(event.timing) : undefined;
   const old = this.tasks.get(taskKey);
   const facts = (item: Record<string, unknown>) => ({ result: item.result, execution: item.execution, role: item.role });
   if (old && (signature(facts(old.view)) !== signature(facts(view)) || (old.timing && timing && signature(old.timing) !== signature(timing)))) this.conflicts++;
   else if (!old || (!old.timing && timing)) this.tasks.set(taskKey, { view, ...(timing ? { timing } : {}) });
  }
 }
 result(epoch?: DispatchEpoch): AsyncDispatchMetrics | undefined {
  if (!this.receipts && !this.events.size && !this.invalid && !this.copied) return undefined;
  let launched = 0, unavailable = 0, excluded = 0; const durations = { queue: [] as Array<number | null>, workspace: [] as Array<number | null>, child: [] as Array<number | null> };
  const selected = (view: Record<string, unknown> | undefined) => {
   if (!epoch) return true;
   const execution = object(view?.execution), provenance = object(execution?.provenance);
   return provenance?.extensionEpoch === epoch.extensionEpoch && provenance?.configurationEpoch === epoch.configurationEpoch && number(execution?.startedAtMs) && execution.startedAtMs >= Math.max(epoch.extensionActivatedAtMs, epoch.configurationActivatedAtMs);
  };
  for (const { view, timing } of this.tasks.values()) {
   const execution = object(view.execution), result = object(view.result), telemetry = object(result?.telemetry);
   if (!selected(view)) { excluded++; continue; }
   if (telemetry?.childStarted === true) launched++; else if (telemetry?.childStarted !== false && execution) unavailable++;
   if (telemetry?.childStarted === true) {
    durations.queue.push(number(timing?.startedAtMs) && number(timing?.queuedAtMs) && timing.startedAtMs >= timing.queuedAtMs ? timing.startedAtMs - timing.queuedAtMs : null);
    durations.workspace.push(number(telemetry.workspaceMs) ? telemetry.workspaceMs : null);
    durations.child.push(number(telemetry.childMs) ? telemetry.childMs : null);
   }
  }
  const sum = (values: Array<number | null>) => values.every(number) ? values.reduce<number>((total, value) => total + value!, 0) : null;
  const terminal = [...this.terminals.values()].filter(event => !epoch || (event.sessions as unknown[]).some(raw => selected(object(raw))));
  const interval = (raw: unknown, start: string, end: string) => { const timing = object(raw); return number(timing?.[start]) && number(timing?.[end]) && timing[end] >= timing[start] ? timing[end] - timing[start] : null; };
  return { receipts: this.receipts, runs: this.runs.size, terminalRuns: terminal.length, terminalTasks: this.tasks.size - excluded, duplicateEvents: this.duplicate, conflictingEvents: this.conflicts, copiedEvents: this.copied, invalidEvents: this.invalid, excludedTasks: excluded,
   launchedChildren: { known: this.conflicts ? 0 : launched, unavailableTasks: this.conflicts ? this.tasks.size : unavailable },
   timing: {
    preparationMs: terminal.length && !this.conflicts ? sum(terminal.map(event => interval(event.timing, "submittedAtMs", "preparedAtMs"))) : null,
    queueMs: this.tasks.size && !this.conflicts ? sum(durations.queue) : null,
    workspaceMs: this.tasks.size && !this.conflicts ? sum(durations.workspace) : null,
    childEffortMs: this.tasks.size && !this.conflicts ? sum(durations.child) : null,
    submissionToTerminalMs: terminal.length && !this.conflicts ? sum(terminal.map(event => interval(event.timing, "submittedAtMs", "finishedAtMs"))) : null,
   },
  };
 }
}
