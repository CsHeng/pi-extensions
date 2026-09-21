import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const theme of ["dark", "light"]) test(`installed Pi ${theme}: real workflow progress, grey strike, list and replay`, { timeout: 45_000 }, async t => {
 try { await access("/usr/bin/script"); } catch { t.skip("util-linux script unavailable; no install performed"); return; }
 const version = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5_000 });
 if (version.status !== 0) { t.skip("installed Pi unavailable"); return; }
 const base = await mkdtemp(join(tmpdir(), "workflow-progress-tui-"));
 const agent = join(base, "agent"); await mkdir(agent);
 await writeFile(join(base, "a"), "fixture a"); await writeFile(join(base, "b"), "fixture b");
 await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], theme, compaction: { enabled: false } }));
 // An explicit alternate source root supports an actual copied-snapshot verification lane.
 const implementation = process.env.CSHENG_WORKFLOW_PROBE_ROOT ?? root;
 const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session", "--no-approve",
  "-e", join(implementation, "extensions/workflow/index.ts"), "-e", join(root, "tests/fixtures/workflow/progress-tui.ts"),
  "--model", "progress-fixture/fixture", "--thinking", "off", "--tui-mode", "fullscreen", "--", "progress fixture"];
 const child = spawn("script", ["-q", "-e", "-f", "-c", `stty cols 160 rows 42; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
  cwd: base, detached: true, env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color", COLORTERM: "truecolor", FORCE_COLOR: "0" },
 });
 let output = "";
 const capture = (data: Buffer) => { output += data.toString(); if (output.length > 2 * 1024 * 1024) { if (child.pid) process.kill(-child.pid, "SIGTERM"); return; } if (data.toString().includes("\x1b[6n")) child.stdin.write("\x1b[1;1R"); };
 child.stdout.on("data", capture); child.stderr.on("data", capture); child.stdin.on("error", () => {});
 const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
 t.after(async () => {
  if (child.exitCode === null && child.signalCode === null && child.pid) {
   try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
   await Promise.race([exited.catch(() => {}), delay(500)]);
   if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ } }
   await exited.catch(() => {});
  }
  await rm(base, { recursive: true, force: true });
 });
 const waitFor = async (check: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await check()) return; if (child.exitCode !== null) break; await delay(40); }
  assert.fail(`${label}; Pi ${version.stdout.trim()}; bounded synthetic output: ${output.slice(-6000)}`);
 };
 await waitFor(async () => { try { return await readFile(join(agent, "ready"), "utf8") === "ready"; } catch { return false; } }, "fixture did not settle");
 assert.match(output, /reported.*awaiting acceptance/); assert.match(output, /1\/2 accepted/);
 assert.match(output, /TRACKING_PAUSED_FIXTURE/); assert.match(output, /2\/2 accepted/);
 const greyStrike = /\x1b\[38;2;(\d+);(\d+);(\d+)m\x1b\[9mSTRIKE_DONE_A\x1b\[29m/;
 const widgetStyle = greyStrike.exec(output); assert.ok(widgetStyle, "real terminal stream retains dim+SGR9 even with FORCE_COLOR=0");
 assert.equal(widgetStyle[1], widgetStyle[2]); assert.equal(widgetStyle[2], widgetStyle[3]);
 const beforeList = output.length; child.stdin.write("/workflow-ui list\r");
 await waitFor(() => output.slice(beforeList).includes("Tasks · workflow"), "list did not mount");
 await delay(150);
 const renderedLines = (chunk: string) => chunk.split(/\r|\n|\x1b\[[0-9;?]*[ABCDEFGHJK]/);
 const beforeSelected = output.length; child.stdin.write("\x1b[B");
 await waitFor(() => renderedLines(output.slice(beforeSelected)).some(line => line.includes("→ ") && greyStrike.test(line)), "selected accepted title lost grey or strike");
 const selected = renderedLines(output.slice(beforeSelected)).find(line => line.includes("→ ") && greyStrike.test(line))!;
 assert.deepEqual(greyStrike.exec(selected)!.slice(1), widgetStyle.slice(1), "selected title must retain the actual widget dim RGB");
 const beforeUnselected = output.length; child.stdin.write("\x1b[A");
 await waitFor(() => renderedLines(output.slice(beforeUnselected)).some(line => !line.includes("→ ") && greyStrike.test(line)), "unselected accepted title lost grey or strike");
 const unselected = renderedLines(output.slice(beforeUnselected)).find(line => !line.includes("→ ") && greyStrike.test(line))!;
 assert.deepEqual(greyStrike.exec(unselected)!.slice(1), widgetStyle.slice(1), "unselected title must retain the actual widget dim RGB");
 child.stdin.write("\x1b"); await delay(200);
 const beforeReload = output.length; child.stdin.write("/reload\r");
 await waitFor(async () => { try { return (await readFile(join(agent, "starts"), "utf8")).trim().split("\n").length >= 2; } catch { return false; } }, "reload did not rebind fixture");
 await waitFor(() => output.slice(beforeReload).includes("2/2 accepted"), "replay lost completed contract");
 assert.match(output.slice(beforeReload), /\x1b\[9mSTRIKE_DONE_A\x1b\[29m/);
 child.stdin.write("/quit\r"); await waitFor(() => child.exitCode !== null, "host did not stop"); assert.equal(await exited, 0);
});
