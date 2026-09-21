/**
 * Opt-in local-source probe, NOT part of `bun run test` and NOT an installed-session audit.
 * Uses the real dependency host and its faux provider. Loads only CC's write leaf,
 * SoL's fusion/pack leaves, and a hash-pinned RTK adapter with pi.exec stubbed.
 * Arguments: --sol-root PATH --cc-root PATH --rtk-source PATH
 * No package discovery, inference, RTK binary, MCP, Bark, Herdr, or UI installation.
 */
import assert from "node:assert/strict";
import { Console } from "node:console";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostHarness } from "../tests/fixtures/workflow/host-fixture.ts";

const receiptOut = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const receiptError = (value: unknown) => process.stderr.write(`${JSON.stringify(value)}\n`);

async function main(): Promise<void> {
const RTK_SHA256 = "d1555e0af5872a30ed04059423350bdb38302f200a9642c5a9bcc519c95a2257";
const argv = process.argv.slice(2);
const flags = ["--sol-root", "--cc-root", "--rtk-source"];
assert.equal(argv.length, 6, "provide exactly the three documented source paths");
const paths = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) {
 const flag = argv[i]!;
 assert.ok(flags.includes(flag) && !paths.has(flag), "unknown or repeated source flag");
 paths.set(flag, resolve(argv[i + 1]!));
}
const solRoot = paths.get("--sol-root")!;
const ccRoot = paths.get("--cc-root")!;
const rtkSource = paths.get("--rtk-source")!;
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const hostRequire = createRequire(hostEntry);
const hostManifest = JSON.parse(await readFile(join(dirname(hostEntry), "../package.json"), "utf8")) as { version: string };
assert.equal(hostManifest.version, "0.86.0", "re-review oracle on host version drift");
const ccManifest = JSON.parse(await readFile(join(ccRoot, "package.json"), "utf8")) as { version: string };
assert.equal(ccManifest.version, "0.8.71", "re-review oracle on CC version drift");
assert.equal(sha256(await readFile(rtkSource)), RTK_SHA256, "RTK adapter must match the documented public commit");

const root = await mkdtemp(join(tmpdir(), "pi-composition-probe-"));
const originalCwd = process.cwd();
const originalConsole = globalThis.console;
let diagnosticWrites = 0;
const diagnosticSink = new Writable({ write(_chunk, _encoding, callback) { diagnosticWrites++; callback(); } });
const live = new Set<HostHarness>();
const receipts: Array<{ check: string; passed: true; detail?: unknown }> = [];
let stage = "isolation";
let cleaned = false;
try {
 // Dependency fail-open errors can contain private paths before our catch runs.
 // Discard their console bytes; keep only a count, never a raw diagnostic buffer.
 globalThis.console = new Console({ stdout: diagnosticSink, stderr: diagnosticSink });
 console.error("injected private-path diagnostic fixture");
 assert.equal(diagnosticWrites, 1, "injected dependency diagnostic must reach the discard sink");
 receipts.push({ check: "dependency-diagnostic-redaction", passed: true, detail: { injectedWritesSuppressed: 1 } });
 // All imports which can discover config happen AFTER isolation. This is a
 // process-local environment, not a security sandbox for hostile source code.
 const path = process.env.PATH;
 for (const key of Object.keys(process.env)) delete process.env[key];
 if (path) process.env.PATH = path;
 process.env.HOME = root;
 process.env.TMPDIR = root;
 process.env.PI_CODING_AGENT_DIR = join(root, "agent");
 process.env.PI_OFFLINE = "1";
 process.env.JITI_FS_CACHE = "0";
 await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
 process.chdir(root);
 globalThis.fetch = async () => { throw new Error("network fetch forbidden in composition probe"); };

 const { createJiti } = await import(pathToFileURL(hostRequire.resolve("jiti")).href);
 const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"].map(name => [name, fileURLToPath(import.meta.resolve(name))])),
 });
 const solFile = (path: string) => join(solRoot, "src/sol-pi", path);
 const fusionPath = solFile("extensions/action-fusion/index.ts");
 const packPath = solFile("extensions/observation-pack/index.ts");
 const ccPath = join(ccRoot, "extensions/renderer/tool/diff/index.ts");
 stage = "source imports";
 const fusion = await jiti.import(fusionPath) as { createActionFusionExtension(): ExtensionFactory };
 const pack = await jiti.import(packPath) as { createObservationPackExtension(): ExtensionFactory };
 const cc = await jiti.import(ccPath) as { installWriteOverride(pi: ExtensionAPI): unknown };
 const rtk = await jiti.import(rtkSource, { default: true }) as ExtensionFactory;
 const { createHostHarness } = await import("../tests/fixtures/workflow/host-fixture.ts");
 const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
 const call = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as never));
 const text = (message: { content?: unknown }) => Array.isArray(message.content)
  ? message.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
 const result = (h: HostHarness, name: string) => {
  const message = h.session.state.messages.findLast(m => m.role === "toolResult" && m.toolName === name);
  assert.ok(message?.role === "toolResult", "expected tool result");
  return message;
 };
 const open = async (extensions: ExtensionFactory[]) => {
  const h = await createHostHarness({ mode: "print", realSessionFile: true, extensions });
  live.add(h);
  return h;
 };
 const close = async (h: HostHarness) => {
  assert.deepEqual(h.errors, [], "host extension errors");
  await h.dispose();
  live.delete(h);
  await assert.rejects(access(h.workDir), "harness workdir must be removed");
 };
 const ccFactory: ExtensionFactory = pi => { pi.on("session_start", () => { cc.installWriteOverride(pi); }); };
 // Mirrors the two actual session_start registrations without importing CC's
 // private TUI patches or SoL's disabled compaction/reducer provider branches.
 const solFactory: ExtensionFactory = pi => { pi.on("session_start", () => { fusion.createActionFusionExtension()(pi); }); };

 stage = "owner and schema";
 for (const order of ["cc-only", "sol-only", "cc-sol", "sol-cc"] as const) {
  let api: ExtensionAPI | undefined;
  const capture: ExtensionFactory = pi => { api = pi; };
  const factories = order === "cc-only" ? [ccFactory] : order === "sol-only" ? [solFactory]
   : order === "cc-sol" ? [ccFactory, solFactory] : [solFactory, ccFactory];
  const h = await open([...factories, capture]);
  const tools = api!.getAllTools();
  const write = tools.find(t => t.name === "write")!;
  const edit = tools.find(t => t.name === "edit")!;
  const hasThenRun = (tool: typeof write) => Object.hasOwn((tool.parameters as { properties: object }).properties, "then_run");
  const solWins = order === "sol-only" || order === "sol-cc";
  assert.equal(hasThenRun(write), solWins, "write schema owner selection");
  assert.equal(hasThenRun(edit), order !== "cc-only", "edit schema owner selection");
  const writeOwner = write.sourceInfo?.path;
  const editOwner = edit.sourceInfo?.path;
  assert.ok(writeOwner, "write must expose source metadata");
  if (solWins) assert.equal(writeOwner, editOwner, "fusion owns both tools");
  if (order === "cc-sol") assert.notEqual(writeOwner, editOwner, "mixed owners");
  h.faux.setResponses([call("write", { path: "owner.txt", content: "fixture", ...(solWins ? { then_run: { command: "printf 'fusion-marker'" } } : {}) }), fauxAssistantMessage("done")]);
  await h.session.prompt("fixture");
  assert.equal(await readFile(join(h.workDir, "owner.txt"), "utf8"), "fixture");
  assert.equal(text(result(h, "write")).includes("[then_run:succeeded]"), solWins, "execute matches schema");
  receipts.push({ check: order, passed: true, detail: { write: solWins ? "SoL fusion" : "CC metadata", writeThenRun: hasThenRun(write), editThenRun: hasThenRun(edit) } });
  await close(h);
 }

 stage = "RTK event coverage and failure semantics";
 let rewrites = 0;
 const rtkStub: ExtensionFactory = pi => rtk({ ...pi, exec: async (command, args) => {
  assert.equal(command, "rtk", "only RTK protocol may hit exec stub");
  if (args[0] === "--version") return { stdout: "rtk 0.23.0", stderr: "", code: 0, killed: false };
  assert.equal(args[0], "rewrite");
  rewrites++;
  return { stdout: "printf 'rewritten-marker'", stderr: "", code: 0, killed: false };
 } });
 const events: string[] = [];
 const observer: ExtensionFactory = pi => {
  pi.on("tool_execution_start", e => { events.push(`start:${e.toolName}`); });
  pi.on("tool_call", e => { events.push(`call:${e.toolName}`); });
  pi.on("tool_result", e => { events.push(`result:${e.toolName}`); });
  pi.on("tool_execution_end", e => { events.push(`end:${e.toolName}`); });
 };
 const fused = await open([solFactory, rtkStub, observer]);
 fused.faux.setResponses([
  call("bash", { command: "printf 'unrewritten-marker'" }),
  call("write", { path: "fused.txt", content: "kept", then_run: { command: "printf 'nested-marker'" } }),
  call("edit", { path: "fused.txt", edits: [{ oldText: "kept", newText: "still-kept" }], then_run: { command: "exit 7" } }),
  fauxAssistantMessage("done"),
 ]);
 await fused.session.prompt("fixture");
 assert.equal(rewrites, 1, "RTK sees top-level bash only, not fused commands");
 assert.equal(text(result(fused, "bash")), "rewritten-marker");
 assert.ok(text(result(fused, "write")).includes("nested-marker"));
 assert.equal(result(fused, "edit").isError, true);
 assert.ok(text(result(fused, "edit")).includes("[then_run:failed]"));
 assert.equal(await readFile(join(fused.workDir, "fused.txt"), "utf8"), "still-kept", "command failure keeps mutation");
 assert.deepEqual(events, ["bash", "write", "edit"].flatMap(name => [`start:${name}`, `call:${name}`, `result:${name}`, `end:${name}`]));
 receipts.push({ check: "rtk-fusion-events", passed: true, detail: { rewriteCalls: rewrites, topLevelBashExecutions: 1, fusedCommands: 2, failedCommandKeptEdit: true, order: ["tool_execution_start", "tool_call", "execute", "tool_result", "tool_execution_end"] } });
 await close(fused);

 stage = "pack projection, history, recall and post-RTK boundary";
 const projections: Array<Array<{ name: string; body: string }>> = [];
 const afterPack: ExtensionFactory = pi => { pi.on("context", event => {
  projections.push(event.messages.filter(m => m.role === "toolResult").map(m => ({ name: m.toolName, body: text(m) })));
 }); };
 const packed = await open([solFactory, rtkStub, pack.createObservationPackExtension(), afterPack]);
 // Each successful fused result is >10KiB, below builtin truncation limits.
 // The marker in the middle must be absent from the placeholder but recalled.
 const large = `${"head fixture\n".repeat(650)}middle-evidence\n${"tail fixture\n".repeat(650)}`;
 await (await import("node:fs/promises")).writeFile(join(packed.workDir, "large.txt"), large);
 packed.faux.setResponses([
  call("write", { path: "packed.txt", content: "fixture", then_run: { command: "cat large.txt" } }),
  fauxAssistantMessage("first"), fauxAssistantMessage("second"), fauxAssistantMessage("third"),
 ]);
 await packed.session.prompt("fixture");
 await packed.session.prompt("fixture");
 await packed.session.prompt("fixture");
 const views = projections.map(p => p.find(m => m.name === "write")?.body).filter((v): v is string => v !== undefined);
 assert.equal(views.length, 3);
 assert.ok(views[0]!.includes("middle-evidence") && views[1]!.includes("middle-evidence"), "first two requests keep full text");
 assert.ok(views[2]!.includes("[large tool result replaced") && !views[2]!.includes("middle-evidence"), "third request gets placeholder");
 assert.ok(text(result(packed, "write")).includes("middle-evidence"), "native history remains full");
 assert.ok((await readFile(packed.session.sessionManager.getSessionFile()!, "utf8")).includes("middle-evidence"), "on-disk native history remains full");
 const id = views[2]!.match(/obs_[a-f0-9]{24}/)?.[0];
 assert.ok(id, "placeholder has recall id");
 packed.faux.setResponses([call("obs_recall", { id, offset: 7000 }), fauxAssistantMessage("recalled")]);
 await packed.session.prompt("fixture");
 assert.ok(text(result(packed, "obs_recall")).includes("middle-evidence"), "recall restores exact retained text");
 const before = rewrites;
 packed.faux.setResponses([call("bash", { command: "cat large.txt" }), fauxAssistantMessage("rtk-output")]);
 await packed.session.prompt("fixture");
 assert.equal(rewrites, before + 1);
 assert.equal(text(result(packed, "bash")), "rewritten-marker", "history archives RTK output, not pre-filter raw log");
 assert.ok(projections.at(-1)!.some(m => m.name === "bash" && m.body === "rewritten-marker"), "small RTK output is not packed");
 receipts.push({ check: "pack-projection-and-recall", passed: true, detail: { fullRequests: 2, thirdRequestPacked: true, fusedOutputEligible: true, nativeHistoryFull: true, recallPassed: true, smallRtkResultUnpacked: true, rawPreRtkRecovery: "not provided by ObservationPack" } });
 await close(packed);

 const sourceFiles = {
  "CC write leaf": ccPath,
  "SoL fusion": fusionPath,
  "SoL then-run": solFile("extensions/action-fusion/then-run.ts"),
  "SoL observation-pack": packPath,
  "SoL observation": solFile("extensions/observation-pack/observation.ts"),
  "RTK adapter": rtkSource,
 };
 const hashes = Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async ([label, path]) => [label, sha256(await readFile(path))])));
 receipts.push({ check: "source-fingerprints", passed: true, detail: { host: hostManifest.version, cc: ccManifest.version, hashes } });
 assert.equal(diagnosticWrites, 1, "unexpected dependency diagnostics; raw text intentionally suppressed");
} catch (error) {
 // Do not export source paths, config, prompts, or arbitrary third-party errors.
 receiptError({ status: "failed", stage, error: error instanceof assert.AssertionError ? "assertion" : "runtime" });
 process.exitCode = 1;
} finally {
 try {
  for (const h of live) await h.dispose();
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
  await assert.rejects(access(root));
  cleaned = true;
 } catch {
  receiptError({ status: "failed", stage: "cleanup" });
  process.exitCode = 1;
 }
 globalThis.console = originalConsole;
 diagnosticSink.end();
}
receiptOut({ status: process.exitCode ? "failed" : "passed", checks: receipts, suppressedDependencyDiagnostics: Math.max(0, diagnosticWrites - 1), cleanup: { temporaryHomesAndSessionsRemoved: cleaned, servicesStarted: 0 }, limits: ["leaf-only CC/SoL integration; no TUI", "RTK adapter real; RTK CLI/rewrite/output fixture stubbed", "faux provider; no inference", "does not establish owner/order in an existing Pi process"] });
}
await main().catch(() => {
 receiptError({ status: "failed", stage: "source preflight", detail: "check required source paths, pinned versions, and adapter hash; paths and third-party errors are not exported" });
 process.exitCode = 1;
});
