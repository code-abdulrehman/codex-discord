import { config } from "./config.js";
import { Store } from "./store.js";
import { AppServer } from "./codex/appServer.js";
import { TaskEngine } from "./codex/taskEngine.js";
import { Bridge } from "./discord/bridge.js";
import { HttpServer } from "./http/server.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const missing: string[] = [];
  if (!config.discordToken) missing.push("DISCORD_TOKEN");
  if (!config.discordClientId) missing.push("DISCORD_CLIENT_ID");
  if (!config.discordClientSecret) missing.push("DISCORD_CLIENT_SECRET");
  if (missing.length > 0) {
    console.error(`Missing required env: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
    console.error("If you don't have a .env next to this file, create one or export the variables.");
    process.exit(1);
  }

  const store = new Store(config.dataDir);
  const bridge = new Bridge(store);

  let http: HttpServer | null = null;
  let currentEngine: TaskEngine | null = null;
  let restarting = false;

  const appServerOpts = {
    codexBin: config.codexBin,
    codexHome: config.codexHome,
    cwd: config.defaultCwd,
    model: config.model,
  };

  async function recover(): Promise<void> {
    if (restarting) return;
    restarting = true;
    await sleep(3000);
    try {
      await startCodex();
      console.log("[app-server] reconnected.");
    } catch (err) {
      console.error("[app-server] restart failed, will retry:", err);
    } finally {
      restarting = false;
    }
  }

  async function startCodex(): Promise<void> {
    const appServer = new AppServer(appServerOpts);
    await appServer.start();
    appServer.on("exited", () => void recover());

    const engine = new TaskEngine(appServer, store);
    engine.start();
    engine.attach(appServer);
    currentEngine = engine;

    bridge.attach(engine);

    if (!http) {
      http = new HttpServer({
        store,
        getEngine: () => currentEngine!,
        notifyUser: (id, title, description) => bridge.dmUser(id, { title, description }),
      });
      await http.listen(config.httpPort);
    }
  }

  await startCodex();

  console.log(`\n  Codex Discord bot is starting.`);
  console.log(`  Dashboard : ${config.publicBaseUrl}   (open this URL → Continue with Discord → run tasks)`);
  console.log(`  Tasks run : ${config.defaultCwd}`);
  console.log(`  Approval  : policy=${config.approvalPolicy} · sandbox=${config.sandbox}\n`);

  await connectDiscord(bridge);
}

/** Keep trying to connect to Discord until it works — the bot stays "live" across outages/token hiccups. */
async function connectDiscord(bridge: Bridge): Promise<void> {
  for (;;) {
    try {
      await bridge.login();
      return;
    } catch (err) {
      console.error(`[discord] login failed: ${(err as Error).message}. Retrying in 10s…`);
      await sleep(10000);
    }
  }
}

export default main;