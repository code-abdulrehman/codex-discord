import dotenv from "dotenv";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env regardless of which directory codex-discord was launched from:
// 1. the current working directory (a local .env overrides),
// 2. the codex-discord package directory (default .env shipped with the bot).
const envCandidates: string[] = [];
envCandidates.push(path.resolve(process.cwd(), ".env"));
try {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  envCandidates.push(path.join(path.resolve(moduleDir, ".."), ".env"));
} catch {
  // ignore
}
for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate });
}

const APPROVAL_POLICIES = ["on-request", "untrusted", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOXES)[number];

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

export interface Config {
  discordToken: string;
  discordClientId: string;
  discordClientSecret: string;
  httpPort: number;
  publicBaseUrl: string;
  redirectUri: string;
  codexBin: string;
  codexHome: string;
  model: string | null;
  defaultCwd: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  allowedUserIds: string[];
  dataDir: string;
  cliSecret: string;
  defaultDiscordUserId: string;
}

const baseUrl = str(process.env.PUBLIC_BASE_URL, `http://localhost:${int(process.env.HTTP_PORT, 3456)}`);
const httpPort = int(process.env.HTTP_PORT, 3456);

const rawPolicy = str(process.env.APPROVAL_POLICY, "on-request");
const rawSandbox = str(process.env.SANDBOX, "workspace-write");

export const config: Config = {
  discordToken: str(process.env.DISCORD_TOKEN, ""),
  discordClientId: str(process.env.DISCORD_CLIENT_ID, ""),
  discordClientSecret: str(process.env.DISCORD_CLIENT_SECRET, ""),
  httpPort,
  publicBaseUrl: baseUrl,
  redirectUri: str(process.env.DISCORD_REDIRECT_URI, `${baseUrl}/auth/discord/callback`),
  codexBin: str(process.env.CODEX_BIN, "codex"),
  codexHome: str(process.env.CODEX_HOME, path.join(homedir(), ".codex")),
  model: process.env.CODEX_MODEL && process.env.CODEX_MODEL.trim().length > 0 ? process.env.CODEX_MODEL.trim() : null,
  defaultCwd: str(process.env.DEFAULT_CWD, process.cwd()),
  approvalPolicy: (APPROVAL_POLICIES as readonly string[]).includes(rawPolicy)
    ? (rawPolicy as ApprovalPolicy)
    : "on-request",
  sandbox: (SANDBOXES as readonly string[]).includes(rawSandbox) ? (rawSandbox as SandboxMode) : "workspace-write",
  allowedUserIds: str(process.env.ALLOWED_DISCORD_IDS, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  dataDir: str(process.env.DATA_DIR, path.resolve(process.cwd(), "data")),
  cliSecret: str(process.env.CLI_SECRET, ""),
  defaultDiscordUserId: str(process.env.DEFAULT_DISCORD_USER_ID, ""),
};