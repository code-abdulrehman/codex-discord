import path from "node:path";

const USAGE = `codex-discord — Codex approval relay via Discord

USAGE:
  codex-discord [options]                    Start the bot (stays connected to Codex + Discord)
  codex-discord run "<prompt>" [--cwd <dir>] Run a codex task from the terminal;
                                             approvals + results go to your Discord DMs
                                             (requires the bot to be running)

OPTIONS:
  -C, --cwd <dir>  Directory codex tasks run in.
                   Defaults to DEFAULT_CWD env, else the current directory.
  -p, --port <port>  HTTP port for the dashboard/OAuth (default 3456).
  -h, --help       Show this help.

ENV:
  Settings come from a .env files — one in the current directory, else the codex-discord install dir.
  Required: DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET.
  For "codex-discord run": CLI_SECRET and DEFAULT_DISCORD_USER_ID (see .env.example).

FLOW:
  1. Run the bot:    codex-discord
  2. Start a task:   /run in Discord, or:  codex-discord run "do something"
  3. Every approval codex needs is sent to your Discord DMs as a button.
     Tap approve/decline and the task continues automatically.`;

export interface ParsedArgs {
  subcommand?: "run";
  prompt?: string;
  cwd?: string;
}

export function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  if (argv[0] === "run") {
    const tokens: string[] = [];
    const parsed: ParsedArgs = { subcommand: "run" };
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--cwd" || a === "-C") {
        const value = argv[++i];
        if (!value) {
          console.error(`Missing value for ${a}`);
          process.exit(2);
        }
        parsed.cwd = path.resolve(value);
      } else if (a === "-h" || a === "--help") {
        console.log(USAGE);
        process.exit(0);
      } else {
        tokens.push(a);
      }
    }
    parsed.prompt = tokens.join(" ").trim();
    if (!parsed.prompt) {
      console.error(`Usage: codex-discord run "<prompt>" [--cwd <dir>]`);
      process.exit(2);
    }
    return parsed;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-C":
      case "--cwd": {
        const value = argv[++i];
        if (!value) {
          console.error(`Missing value for ${arg}`);
          process.exit(2);
        }
        process.env.DEFAULT_CWD = path.resolve(value);
        break;
      }
      case "-p":
      case "--port": {
        const value = argv[++i];
        if (!value || !/^\d+$/.test(value)) {
          console.error(`Invalid port for ${arg}`);
          process.exit(2);
        }
        process.env.HTTP_PORT = value;
        break;
      }
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}\n\n${USAGE}`);
        process.exit(2);
    }
  }
  return {};
}

/** One-shot `codex-discord run "prompt"`: ask the running bot to start a task. */
export async function runCli(args: ParsedArgs): Promise<void> {
  const { config } = await import("./config.js");
  if (!config.cliSecret) {
    console.error(`Set CLI_SECRET in .env (the one the bot uses) to enable "codex-discord run".`);
    process.exit(1);
  }
  const cwd = args.cwd ?? process.cwd();
  const res = await fetch(`${config.publicBaseUrl}/api/cli/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.cliSecret}` },
    body: JSON.stringify({ prompt: args.prompt, cwd }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; taskId?: string; error?: string };
  if (res.ok && body.ok) {
    console.log(`✅ Task ${body.taskId} started. Approvals & results will arrive in your Discord DMs.`);
    process.exit(0);
  }
  const detail = body.error ?? `HTTP ${res.status} (${config.publicBaseUrl}) — is the bot running?`;
  console.error(`❌ ${detail}`);
  process.exit(1);
}