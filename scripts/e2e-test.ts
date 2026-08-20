import process from "node:process";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.APPROVAL_POLICY = "untrusted";
process.env.DATA_DIR = path.join(tmpdir(), "codex-discord-e2e");
process.env.DEFAULT_CWD = process.cwd();
process.env.CODEX_BIN = process.env.CODEX_BIN ?? "/usr/local/bin/codex";
// Remove broken/conflicting codex shims (e.g. a stale global npm `codex`) that can
// shadow the real CLI when running under npx/tsx.
process.env.PATH = process.env.PATH!.split(":")
  .filter((p) => !p.includes("/node_modules/") && !p.includes("_npx"))
  .concat("/usr/local/bin")
  .join(":");

const { AppServer } = await import("../src/codex/appServer.js");
const { TaskEngine } = await import("../src/codex/taskEngine.js");
const { Store } = await import("../src/store.js");
const { config } = await import("../src/config.js");

const store = new Store(config.dataDir);
const appServer = new AppServer({
  codexBin: config.codexBin,
  codexHome: config.codexHome,
  cwd: config.defaultCwd,
  model: config.model,
});
const engine = new TaskEngine(appServer, store);

let approvals = 0;
let currentTaskId: string | null = null;

engine.on("approval", (pending) => {
  approvals++;
  console.log(`\n>>> APPROVAL #${approvals} (${pending.kind})\n`, JSON.stringify(pending.params, null, 2).slice(0, 800));
  const decided = engine.resolveApproval(pending.taskId, pending.requestId, { decision: "accept" }, "approved (test)");
  console.log(`>>> resolved=${decided}`);
});

engine.on("taskStarted", (t) => console.log("\n>>> taskStarted", t.id));

engine.on("taskDone", async (t) => {
  if (t.id !== currentTaskId) {
    console.log(`>>> ignoring stale taskDone for ${t.id}`);
    return;
  }
  console.log(`\n>>> taskDone status=${t.status}`);
  console.log(">>> finalText:", t.finalText, "\n>>> error:", t.error ?? "none");
  cleanup();
});

engine.on("approvalResolved", (e) => console.log(`>>> approvalResolved ${e.taskId} ${String(e.requestId)} -> ${e.label}`));

appServer.on("notification", (n) => {
  if (["turn/completed", "item/started", "item/completed", "thread/status/changed", "serverRequest/resolved"].includes(n.method)) {
    const summary = JSON.stringify(n.params)?.slice(0, 260);
    console.log(`>>> NOTIFY ${n.method} ${summary}`);
  }
});

const timeout = setTimeout(() => {
  console.log(">>> TIMEOUT: turn did not finish");
  cleanup();
}, 120000);

function cleanup() {
  clearTimeout(timeout);
  appServer.stop();
  setTimeout(() => process.exit(0), 500);
}

await appServer.start();
engine.start();
engine.attach(appServer);

console.log(">>> starting approval-driven task");
const task = await engine.startTask({
  discordUserId: "test-user",
  prompt:
    "Create a file notes.txt containing the line 'hello from codex-discord'. Then read it back and tell me its contents in one line. Keep it minimal.",
});
currentTaskId = task.id;
console.log(">>> task id:", task.id);