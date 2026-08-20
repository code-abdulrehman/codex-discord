import express from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { Store } from "../store.js";
import { TaskEngine } from "../codex/taskEngine.js";
import { escapeHtml } from "./html.js";

export interface HttpServerOptions {
  store: Store;
  getEngine: () => TaskEngine;
  notifyUser: (discordId: string, title: string, description: string) => Promise<void>;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export class HttpServer {
  private app = express();
  private server: Server | null = null;

  constructor(private opts: HttpServerOptions) {
    const { store, getEngine, notifyUser } = opts;
    this.app.use(express.urlencoded({ extended: false }));
    this.app.use(express.json());

    this.app.get("/healthz", (_req, res) => res.status(200).send("ok"));

    this.app.get("/", (req, res) => {
      const sessionUser = this.sessionUser(req);
      if (sessionUser) {
        res.redirect("/me");
        return;
      }
      res.status(200).send(
        page(
          "Codex · Discord",
          `
        <div class="card">
          <h1>🧠 Codex · Discord</h1>
          <p class="muted">Run Codex tasks from one link. Approve every codex action right from Discord.</p>
          <p>
            <a class="btn" href="/auth/discord">→ Continue with Discord</a>
          </p>
          <p class="muted small">You must add the bot to your Discord and open this URL once. The link only reads your user id (identify scope).</p>
        </div>
      `,
        ),
      );
    });

    this.app.get("/auth/discord", (_req, res) => {
      const state = randomBytes(16).toString("hex");
      const url = new URL("https://discord.com/api/oauth2/authorize");
      url.searchParams.set("client_id", config.discordClientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("scope", "identify");
      url.searchParams.set("state", state);
      res.redirect(url.toString());
    });

    this.app.get("/auth/discord/callback", async (req, res) => {
      const code = req.query.code as string | undefined;
      if (!code) {
        res.status(400).send(page("Auth failed", `<div class="card"><h1>❌ No auth code</h1><a href="/">Try again</a></div>`));
        return;
      }
      try {
        const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.discordClientId,
            client_secret: config.discordClientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: config.redirectUri,
          }),
        });
        if (!tokenRes.ok) {
          const detail = await tokenRes.text();
          throw new Error(`token exchange failed (${tokenRes.status}) ${detail.slice(0, 200)}`);
        }
        const token = (await tokenRes.json()) as { access_token: string };
        const meRes = await fetch("https://discord.com/api/users/@me", {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        if (!meRes.ok) throw new Error(`users/@me failed (${meRes.status})`);
        const me = (await meRes.json()) as {
          id: string;
          username: string;
          global_name: string | null;
          avatar: string | null;
          discriminator: string;
        };

        if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(me.id)) {
          res.status(403).send(
            page("Not allowed", `<div class="card"><h1>🚫 Access denied</h1><p class="muted">Your Discord account is not on the allowlist.</p></div>`),
          );
          return;
        }

        const avatarUrl = me.avatar
          ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
          : null;
        store.upsertUser({
          id: me.id,
          username: me.username,
          globalName: me.global_name,
          avatarUrl,
          linkedAt: Date.now(),
        });

        const sessionToken = randomBytes(24).toString("hex");
        store.createSession(sessionToken, me.id);

        res.setHeader(
          "Set-Cookie",
          `cd_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
        );

        await notifyUser(
          me.id,
          `✅ Linked: ${me.global_name ?? me.username}`,
          `Your Discord is now linked to Codex. Start a task with \`/run\` or head back to the dashboard.\n\nApprovals from running tasks will appear here.`,
        );

        res.redirect("/me");
      } catch (err) {
        console.error("[http] oauth callback error:", err);
        res.status(500).send(
          page("Auth failed", `<div class="card"><h1>❌ Auth failed</h1><p class="muted">${escapeHtml((err as Error).message)}</p><a href="/">Try again</a></div>`),
        );
      }
    });

    this.app.get("/me", (req, res) => {
      const user = this.sessionUser(req);
      if (!user) {
        res.redirect("/");
        return;
      }
      const tasks = store.listTasks(user.id).slice(0, 10);
      res.status(200).send(
        page(
          `Dashboard · ${user.globalName ?? user.username}`,
          this.dashboardHtml(user, tasks),
        ),
      );
    });

    this.app.post("/api/run", async (req, res) => {
      const user = this.sessionUser(req);
      if (!user) {
        res.status(401).json({ ok: false, error: "not authenticated" });
        return;
      }
      const prompt = String(req.body?.prompt ?? "").trim();
      const cwd = String(req.body?.cwd ?? "").trim() || undefined;
      if (!prompt) {
        res.status(400).json({ ok: false, error: "prompt is required" });
        return;
      }
      try {
        const task = await getEngine().startTask({ discordUserId: user.id, prompt, cwd });
        res.json({ ok: true, taskId: task.id, prompt: task.prompt });
      } catch (err) {
        res.status(500).json({ ok: false, error: (err as Error).message ?? String(err) });
      }
    });

    this.app.get("/api/tasks", (req, res) => {
      const user = this.sessionUser(req);
      if (!user) {
        res.status(401).json({ ok: false, error: "not authenticated" });
        return;
      }
      res.json({ tasks: store.listTasks(user.id) });
    });

    this.app.post("/api/stop", async (req, res) => {
      const user = this.sessionUser(req);
      if (!user) {
        res.status(401).json({ ok: false, error: "not authenticated" });
        return;
      }
      const taskId = String(req.body?.taskId ?? "");
      const task = store.getTask(taskId);
      if (!task || task.discordUserId !== user.id) {
        res.status(404).json({ ok: false, error: "task not found" });
        return;
      }
      await getEngine().stopTask(taskId);
      res.json({ ok: true });
    });

    // Terminal integration: `codex-discord run "<prompt>"`.
    this.app.post("/api/cli/run", async (req, res) => {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!config.cliSecret || bearer !== config.cliSecret) {
        res.status(401).json({ ok: false, error: "unauthorized: CLI_SECRET mismatch" });
        return;
      }
      const prompt = String(req.body?.prompt ?? "").trim();
      const cwd = String(req.body?.cwd ?? "").trim() || undefined;
      if (!prompt) {
        res.status(400).json({ ok: false, error: "prompt is required" });
        return;
      }
      if (!config.defaultDiscordUserId) {
        res.status(400).json({ ok: false, error: "DEFAULT_DISCORD_USER_ID is not set in .env" });
        return;
      }
      try {
        const task = await getEngine().startTask({ discordUserId: config.defaultDiscordUserId, prompt, cwd });
        res.json({ ok: true, taskId: task.id, prompt: task.prompt });
      } catch (err) {
        res.status(500).json({ ok: false, error: (err as Error).message ?? String(err) });
      }
    });
  }

  private sessionUser(req: express.Request) {
    const cookies = parseCookies(req.headers.cookie);
    const session = cookies["cd_session"] ? this.opts.store.getSession(cookies["cd_session"]) : null;
    if (!session) return null;
    return this.opts.store.getUser(session.discordId);
  }

  private dashboardHtml(user: { username: string; globalName: string | null; avatarUrl: string | null }, tasks: any[]): string {
    const avatar = user.avatarUrl
      ? `<img class="avatar" src="${user.avatarUrl}" alt="" />`
      : `<span class="avatar avatar-placeholder">${escapeHtml((user.globalName ?? user.username).slice(0, 1).toUpperCase())}</span>`;
    const taskRows =
      tasks.length === 0
        ? `<tr><td colspan="4" class="muted">No tasks yet — run one below 👇</td></tr>`
        : tasks
            .map(
              (t) => `
            <tr>
              <td><code>${escapeHtml(t.id)}</code></td>
              <td>${escapeHtml(t.prompt).slice(0, 60)}${escapeHtml(t.prompt).length > 60 ? "…" : ""}</td>
              <td>${statusBadge(t.status)}</td>
              <td>
                ${["running", "awaitingApproval"].includes(t.status) ? `<button class="btn btn-sm" onclick="stopTask('${escapeHtml(t.id)}')">Stop</button>` : ""}
              </td>
            </tr>`,
            )
            .join("");
    return `
      <div class="card">
        <div class="row">
          ${avatar}
          <div>
            <h1>Hi, ${escapeHtml(user.globalName ?? user.username)}</h1>
            <p class="muted small">Authenticated via Discord — approvals land in your DMs.</p>
          </div>
        </div>

        <h2>▶ Run a Codex task</h2>
        <form onsubmit="run(event)">
          <label>Prompt</label>
          <textarea name="prompt" rows="3" required placeholder="e.g. Add a /ping command to the bot, write a test, fix the failing build…"></textarea>
          <label>Working directory (optional)</label>
          <input name="cwd" placeholder="${escapeHtml(config.defaultCwd)}" />
          <button class="btn" type="submit">Start task</button>
          <span id="runStatus" class="muted small"></span>
        </form>

        <h2>📋 Recent tasks</h2>
        <table>
          <thead><tr><th>ID</th><th>Prompt</th><th>Status</th><th></th></tr></thead>
          <tbody>${taskRows}</tbody>
        </table>
      </div>
      <script>
        async function run(ev) {
          ev.preventDefault();
          const f = ev.target;
          const status = document.getElementById("runStatus");
          status.textContent = "Starting…";
          try {
            const r = await fetch("/api/run", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                prompt: f.prompt.value,
                cwd: f.cwd.value || undefined,
              }),
            });
            const j = await r.json();
            if (j.ok) {
              status.textContent = "✅ Started — check your Discord DMs!";
              setTimeout(() => location.reload(), 1200);
            } else {
              status.textContent = "❌ " + j.error;
            }
          } catch (e) {
            status.textContent = "❌ " + e.message;
          }
        }
        async function stopTask(id) {
          await fetch("/api/stop", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taskId: id }),
          });
          location.reload();
        }
      </script>
    `;
  }

  async listen(port: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server = this.app.listen(port, () => resolve());
    });
    console.log(`[http] dashboard on ${config.publicBaseUrl}`);
  }

  close(): void {
    this.server?.close();
  }
}

function statusBadge(status: string): string {
  const map: Record<string, [string, string]> = {
    running: ["Running", "#3b82f6"],
    awaitingApproval: ["Awaiting approval", "#f59e0b"],
    completed: ["Completed", "#22c55e"],
    failed: ["Failed", "#ef4444"],
    interrupted: ["Interrupted", "#6b7280"],
  };
  const [label, color] = map[status] ?? [status, "#6b7280"];
  return `<span class="badge" style="color:${color};border-color:${color}">${label}</span>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #0f1115; color: #e5e7eb; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #181b21; border: 1px solid #2a2d38; border-radius: 16px; padding: 32px; max-width: 640px; width: 100%; margin: 24px; box-shadow: 0 10px 40px rgba(0,0,0,.35); }
  h1 { margin: 0 0 8px; font-size: 24px; }
  h2 { margin: 28px 0 8px; font-size: 17px; }
  p { line-height: 1.5; }
  .muted { color: #8b93a7; }
  .small { font-size: 13px; }
  .btn { display: inline-block; background: #5865f2; color: #fff; border: 0; padding: 10px 16px; border-radius: 8px; text-decoration: none; cursor: pointer; font-size: 15px; }
  .btn-sm { padding: 4px 10px; font-size: 12px; background: #343a46; }
  .row { display: flex; gap: 14px; align-items: center; }
  .avatar { width: 56px; height: 56px; border-radius: 50%; }
  .avatar-placeholder { display: grid; place-items: center; background: #5865f2; font-weight: 700; }
  form { display: flex; flex-direction: column; gap: 6px; }
  label { font-size: 13px; color: #8b93a7; margin-top: 8px; }
  textarea, input { background: #0f1115; border: 1px solid #2a2d38; border-radius: 8px; color: #e5e7eb; padding: 10px; font: inherit; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #23262f; font-size: 14px; vertical-align: top; }
  .badge { border: 1px solid; border-radius: 999px; font-size: 11px; padding: 2px 8px; white-space: nowrap; }
  code { background: #0f1115; padding: 1px 5px; border-radius: 5px; font-size: 12px; }
</style>
</head>
<body>${body}</body>
</html>`;
}