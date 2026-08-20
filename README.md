# Codex · Discord

Run **Codex** anywhere, approve everything from **Discord**.

Start a task with one command or one Discord message. Whenever Codex needs an
approval (running a command, changing files, network access), the bot sends an
approval button to your **Discord DMs**. You tap *Approve / Approve session /
Decline* and the task continues automatically.

```
  Terminal                             Discord                     Codex CLI
 ┌────────────┐   HTTP/localhost   ┌────────────────┐    ┌──────────────────────┐
 │ codex-discord run "fix tests"   │  ✅ approve?    │    │  codex app-server     │
 │  (or /run on Discord) ─────────▶│  [✓][✓][✕]     │◀──▶│  (real Codex engine)   │
 └────────────┘                    │  results in DM │    └──────────────────────┘
                                    └────────────────┘
```

---

## What you need (new device checklist)

| # | Requirement | How to check / install |
|---|-------------|------------------------|
| 1 | Node.js **20+** | `node -v` — if missing, install from https://nodejs.org (or `brew install node`, `asdf install nodejs 24`) |
| 2 | Codex CLI (logged in) | `codex --version` then `codex login` (open the printed URL, authorize) |
| 3 | Discord account | https://discord.com (register / log in) |
| 4 | The bot added to a **server you are in** | OAuth invite (see step 5) — **required**, otherwise the bot cannot DM you |

> 💡 **Important:** Discord only lets a bot send DMs to users with whom it shares
> at least one **mutual server (guild)**. If you get
> `Cannot send messages to this user due to having no mutual guilds`, the bot is
> not in any server with you — invite it (step 5).

---

## Step 1 — Install Node.js + Codex

```bash
node -v                  # must be >= 20
npm -v

# Codex CLI (OpenAI). If you already use `codex`, skip to `codex login`.
curl -fsSL https://chatgpt.com/codex/install.sh | sh

codex --version
codex login              # opens a browser — authorize your OpenAI account
codex doctor             # optional: check that everything is healthy
```

---

## Step 2 — Get this project

```bash
git clone <your-repo-url> codex-discord   # or copy the folder / download
cd codex-discord

npm install              # install dependencies
npm run build            # compile TypeScript
npm link                 # make `codex-discord` available globally (any directory)
```

To unlink later: `npm unlink -g codex-discord && npm unlink` (inside the folder).

> `npm link` creates a global `codex-discord` command. If it’s not on PATH, check
> `npm bin -g` and add it, or run the bot with `node dist/index.js` instead.

---

## Step 3 — Create the Discord Application (bot)

1. Open the **Discord Developer Portal** → https://discord.com/developers/applications
2. **New Application** → name it e.g. `codex-relay` → **Create**.
3. Copy the **Application ID** (this is `DISCORD_CLIENT_ID`).

### 3a. Set up OAuth2 (for the optional web login/dashboard)
4. Left menu → **OAuth2 → General**.
5. Copy **Client Secret** (click *Reset Secret* first to reveal it).
6. Under **Redirects** add exactly:
   - `http://localhost:3456/auth/discord/callback`

### 3b. Create the bot
7. Left menu → **Bot**.
8. Click **Reset Token** → copy the **Bot Token** (`DISCORD_TOKEN`).
9. Turn **ON** `Message Content Intent` (Privileged Gateway Intents).

---

## Step 4 — Create a Discord server & add the bot

1. In Discord: **+** (left sidebar) → **Create My Own Server** → name it (e.g. `codex`).
   - (If your Discord uses an existing server, you can use that one instead.)
2. Get the bot invite link:

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=18432&scope=bot applications.commands
   ```

   Replace `YOUR_CLIENT_ID`. Open it in a browser, pick your server, press
   **Authorize**. The bot (`codex_notify#....`) now appears in the server's
   member list — this is what unlocks DMs.

3. Optional — make a channel the bot can also post to:
   - Create a channel (e.g. `#codex-logs`), add the bot to it, and allow it
     `Send Messages` + `Embed Links`.

---

## Step 5 — Get your Discord User ID

The bot sends approvals to **your user ID**. To find it:

1. Discord → **User Settings → Advanced → Turn ON Developer Mode**.
2. **Right-click on your name** in any message → **Copy User ID**.
   - It looks like a number: `1481513546939367556`.

Keep it; it goes in `.env` as `DEFAULT_DISCORD_USER_ID`.

---

## Step 6 — Create `.env`

```bash
cd codex-discord
cp .env.example .env
nano .env     # or open it in any editor
```

Fill in (required):

| Variable | Value |
|----------|-------|
| `DISCORD_TOKEN` | Bot token (Step 3b.8) |
| `DISCORD_CLIENT_ID` | Application ID (Step 3.3) |
| `DISCORD_CLIENT_SECRET` | OAuth2 Client Secret (Step 3a.5) |
| `DEFAULT_DISCORD_USER_ID` | Your User ID (Step 5) |
| `CLI_SECRET` | Any random secret (`openssl rand -hex 16` — keep it private) |

Useful optional ones:

| Variable | Default | Meaning |
|----------|---------|---------|
| `PUBLIC_BASE_URL` | `http://localhost:3456` | Dashboard URL (use https/tunnel for remote) |
| `DISCORD_REDIRECT_URI` | `http://localhost:3456/auth/discord/callback` | Must match Step 3a.6 |
| `HTTP_PORT` | `3456` | Dashboard port |
| `DEFAULT_CWD` | directory you launch from | Where tasks run when no `--cwd` given |
| `APPROVAL_POLICY` | `on-request` | `on-request` = ask only when needed · `untrusted` = ask for every command/file change · `never` = auto-approve (no notifications) |
| `SANDBOX` | `workspace-write` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `CODEX_BIN` | `codex` | Path to codex binary |
| `CODEX_HOME` | `~/.codex` | Codex data dir |
| `CODEX_MODEL` | *(default)* | e.g. `gpt-5.1-codex-mini` |
| `ALLOWED_DISCORD_IDS` | *(empty = anyone)* | Comma-separated Discord user IDs allowed to use the bot |
| `DATA_DIR` | `./data` | Where users/sessions/tasks are stored |

> The `.env` is found automatically: first in your **current directory**, else in
> the **codex-discord install directory**. So `codex-discord` works from any folder.

---

## Step 7 — Run it

```bash
# From anywhere (global command):
codex-discord

# Or with an explicit task directory / port:
codex-discord --cwd /Users/you/my-project --port 3456
```

You should see:

```
[app-server] connected (macos/unix, codex home /Users/dycoders/.codex, …)
[http] dashboard on http://localhost:3456
[discord] ready as codex_notify#…. 7 commands registered
```

That means: Codex engine connected, dashboard up, Discord bot online. It stays
connected all the time — if codex or Discord drops, it reconnects automatically.

---

## Step 8 — Use it

### A. Terminal (like normal codex, but approvals on Discord)

```bash
codex-discord run "fix the failing tests" --cwd /Users/you/my-project
```

Output is minimal; the **approval buttons and the final result arrive in your
Discord DMs**. `codex-discord run` requires the bot to be running (Step 7).

### B. Discord

In the bot’s DMs (or any server with the bot), type:

| Command | What it does |
|---------|--------------|
| `/invite` | Show the invite link to add the bot to a server |
| `/testnotify` | Send a test notification to your DMs (verify everything) |
| `/run <prompt> [cwd]` | Start a Codex task |
| `/status` | List your recent tasks |
| `/approvals` | List tasks currently waiting on your approval |
| `/stop [task]` | Interrupt a running task |
| `/login` | (Optional) one-link web auth to get the dashboard session |

### C. Web dashboard (optional)

Open `http://localhost:3456` → **Continue with Discord** → authorize →
type a prompt → **Start task**. Tasks and status are listed there too.

### The approval flow

1. Task starts → bot DMs you **🎯 Codex task started**.
2. Codex needs approval (command / file change / permissions) → bot DMs an embed
   with buttons:
   - **✓ Approve** — allow this one action
   - **✓ Approve session** — allow all actions like this for the session
   - **✕ Decline** — block this action
3. You tap a button → Codex continues/resumes automatically.
4. When the turn finishes → bot DMs **✅ Codex task complete** (with the result).

---

## Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `Cannot send messages to this user due to having no mutual guilds` | Bot is not in a server with you. Use the bot invite (Step 4) in a server you own. |
| `Missing required env: DISCORD_TOKEN, …` | `.env` missing/empty. Create it (Step 6) next to `codex-discord` or export the vars. |
| `An invalid token was provided` | `DISCORD_TOKEN` wrong. Reset token in Developer Portal (Step 3b). Bot retries login every 10 s — fix it and it reconnects. |
| Bot connects but tasks fail with a model error | Your ChatGPT plan may not support the model; leave `CODEX_MODEL` empty to use the default, or set a supported one. |
| Commands like `/run` don't appear | Global commands take a few seconds after `ready`. If still missing, kick the bot from the server and re-invite. |
| Approvals never appear (policy analysis) | With `APPROVAL_POLICY=on-request` safe actions auto-run. Set `APPROVAL_POLICY=untrusted` to be asked for every command/file change. |
| Port 3456 already in use | Change `HTTP_PORT` in `.env` or pass `--port`. |
| Sandbox errors | Use `SANDBOX=danger-full-access` only if codex's sandbox is unavailable on your OS/install. |
| Bot not in server / DM settings | Discord → server → ensure the bot user is present; the user must have "Allow direct messages from server members" enabled. |

---

## Keep it running 24/7

- **This machine, current session:** the bot keeps running in the background
  (started with `nohup` / a terminal). `tail -f /tmp/codex-discord.log` to watch.
- **Start automatically at login (macOS, launchd):** create
  `~/Library/LaunchAgents/com.codexdiscord.bot.plist`:

  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>Label</key><string>com.codexdiscord.bot</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/codex-discord</string>
      <string>--cwd</string>
      <string>/Users/you/my-project</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/codex-discord.log</string>
    <key>StandardErrorPath</key><string>/tmp/codex-discord.err.log</string>
  </dict>
  </plist>
  ```

  ```bash
  launchctl load ~/Library/LaunchAgents/com.codexdiscord.bot.plist
  ```

- **Remote server:** expose the dashboard with `ngrok http 3456` (update
  `PUBLIC_BASE_URL` + the OAuth Redirect to the https URL) or put it behind a
  reverse proxy. Tunnel only when you trust the CLI secret.

---

## Security notes

- `CLI_SECRET` lets anyone with it start tasks against the running bot — keep it
  secret and only run the dashboard on localhost / a trusted network.
- Tasks run **as your local user** with the sandbox you choose. Prefer
  `workspace-write` over `danger-full-access`. Review before approving.
- Only `identify` scope is used for the web OAuth login (read-only).
- Store customer/user ID allowlists via `ALLOWED_DISCORD_IDS` on shared machines.

## Project layout

```
codex-discord/
├── src/
│   ├── index.ts          # CLI entry (start / run subcommand)
│   ├── cli.ts            # global CLI parsing + `codex-discord run`
│   ├── config.ts         # env/.env loading
│   ├── main.ts           # boot: codex app-server + discord + http
│   ├── store.ts          # users/sessions/tasks persistence (JSON)
│   ├── codex/
│   │   ├── jsonrpc.ts    # JSON-RPC (JSONL) client for codex app-server
│   │   ├── appServer.ts  # manages the codex app-server process
│   │   └── taskEngine.ts # tasks + approval routing
│   ├── discord/bridge.ts # slash commands, buttons, DM rendering
│   └── http/server.ts    # OAuth login + dashboard (+ CLI run API)
├── scripts/e2e-test.ts   # automated end-to-end pipeline test
├── .env.example
└── README.md
```

Built on the official, experimental **Codex app-server** protocol
(`codex app-server`, JSON-RPC over stdio). Not for production workloads without
review.