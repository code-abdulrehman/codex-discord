#!/usr/bin/env node

// Global CLI entry. Parses CLI flags BEFORE config/env load so that
// `codex-discord --cwd /any/dir` works from any directory.
import { parseArgs, runCli } from "./cli.js";

const parsed = parseArgs();

if (parsed.subcommand === "run") {
  await runCli(parsed);
  process.exit(0);
}

const { default: main } = await import("./main.js");
await main();