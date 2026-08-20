# AGENTS.md

Guidance for coding agents (opencode, Claude Code, Cursor, etc.) working in this repo.

## What this project is

A local bot that relays **Codex approval requests to Discord**. It runs a real
`codex app-server` process (JSON-RPC over stdio/JSONL) as its engine. When Codex
needs approval (running a command, changing files, network access), the bot sends
an approval embed with buttons to the user's Discord DMs; clicking a button sends
the decision back to the app-server and the task continues.

Key facts an agent must know:
- The protocol is **experimental**. Never invent message shapes — regenerate types
  with `codex app-server generate-ts --out <dir>` and read them, or verify against
  the running app-server with a throwaway script.
- `codex app-server` must be spawned with `--listen stdio://` and spoken to via
  newline-delimited JSON-RPC (`{method,id,params}` / `{id,result}` — the
  `jsonrpc` header is omitted on the wire).
- Approval requests are **server→client requests** (they carry an `id` and must be
  answered with `{id, result}`, e.g. `{"decision":"accept"}`).
- Notifications arrive as `{method, params}` without `id`.
- Never break the invariant: engine receives and responds to every
  `item/*/requestApproval`; `serverRequest/resolved` clears pending approvals.
- DMs require a **mutual guild** between the bot and the user. `no mutual guilds`
  failure is an invitation/onboarding problem, not a code bug.

## What an agent MUST ask the user to do (can't be automated)

These need a human, because they require the user's own accounts and the Discord
Developer Portal / browser:

1. **Discord credentials** — `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
   `DISCORD_CLIENT_SECRET` come from https://discord.com/developers/applications.
   Do NOT guess, generate, or invent them. Ask the user to copy/ paste them.
2. **`DEFAULT_DISCORD_USER_ID`** — the user's Discord User ID (Developer Mode →
   right-click profile → Copy User ID). Ask the user for it.
3. **`codex login`** (OpenAI account) — run once when setting up a new device.
4. **Adding the bot to a server** — only the user can open the OAuth invite and
   authorize (or route the invite link to them). Needed for DMs to work.
5. **`.env` writing** — you may scaffold `.env` from `.env.example`, but fill
   credential values only from what the user provided. Never paste real secrets
   into code, logs, or commits.

## What an agent CAN do by itself

- `npm install`, `npm run build`, `npm run typecheck`
- Run the bot: `node dist/index.js` (or `npx tsx src/index.ts` for dev).
  Do NOT paste/commit the user's secrets; keep any test runs on local `nohup` with
  logs in `/tmp`.
- Run the end-to-end check: `npx tsx scripts/e2e-test.ts`
  (verifies codex app-server connect → task → approval → accept → turn completed).
  It overrides env internally; it never uses Discord credentials.
- Use the CLI: `codex-discord run "<prompt>"` (requires the bot running locally;
  hits `POST /api/cli/run` with `CLI_SECRET`).
- Edit code, add slash commands in `src/discord/bridge.ts`, add config in
  `src/config.ts` (+ `.env.example` + `README.md`), extend approvals in
  `src/codex/taskEngine.ts`.

## When to ask vs. just do

- Task needs a real API action on the user's Discord/OpenAI accounts → **ask user**.
- Task is local code, tests, docs, or env-file scaffolding → **do it**, then tell
  the user exactly what to paste and where.

## Commands

```bash
npm install
npm run build       # tsc -p tsconfig.json
npm run typecheck   # tsc --noEmit
npx tsx scripts/e2e-test.ts   # local pipeline test (no Discord needed)
codex-discord --help          # global CLI (uses global npm link)
node dist/index.js            # start the bot from this dir
```

## Environment

- Node.js 20+. TypeScript strict, ESM (`"type":"module"`).
- `.env` is gitignored; `.env.example` documents all variables.
- `data/` holds users/sessions/tasks JSON — gitignored, local state only.