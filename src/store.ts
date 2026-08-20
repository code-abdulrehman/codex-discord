import fs from "node:fs";
import path from "node:path";

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export interface UserRecord {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  linkedAt: number;
}

export interface SessionRecord {
  token: string;
  discordId: string;
  createdAt: number;
}

export type TaskStatus = "running" | "awaitingApproval" | "completed" | "failed" | "interrupted";

export interface TaskRecord {
  id: string;
  discordUserId: string;
  prompt: string;
  cwd: string;
  threadId: string;
  turnId: string | null;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  finalText?: string;
  error?: string;
}

export class Store {
  private users: Record<string, UserRecord>;
  private sessions: Record<string, SessionRecord>;
  private tasks: Record<string, TaskRecord>;
  private usersFile: string;
  private sessionsFile: string;
  private tasksFile: string;

  constructor(dataDir: string) {
    this.usersFile = path.join(dataDir, "users.json");
    this.sessionsFile = path.join(dataDir, "sessions.json");
    this.tasksFile = path.join(dataDir, "tasks.json");
    this.users = readJson(this.usersFile, {});
    this.sessions = readJson(this.sessionsFile, {});
    this.tasks = readJson(this.tasksFile, {});
  }

  // ---- users ----
  getUser(id: string): UserRecord | null {
    return this.users[id] ?? null;
  }
  listUsers(): UserRecord[] {
    return Object.values(this.users);
  }
  upsertUser(user: UserRecord): void {
    this.users[user.id] = user;
    writeJson(this.usersFile, this.users);
  }

  // ---- sessions ----
  getSession(token: string): SessionRecord | null {
    return this.sessions[token] ?? null;
  }
  createSession(token: string, discordId: string): SessionRecord {
    const rec: SessionRecord = { token, discordId, createdAt: Date.now() };
    this.sessions[token] = rec;
    writeJson(this.sessionsFile, this.sessions);
    return rec;
  }

  // ---- tasks ----
  getTask(id: string): TaskRecord | null {
    return this.tasks[id] ?? null;
  }
  listTasks(discordUserId?: string): TaskRecord[] {
    const all = Object.values(this.tasks);
    const filtered = discordUserId ? all.filter((t) => t.discordUserId === discordUserId) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }
  saveTask(task: TaskRecord): void {
    this.tasks[task.id] = task;
    writeJson(this.tasksFile, this.tasks);
  }
  patchTask(id: string, patch: Partial<TaskRecord>): TaskRecord | null {
    const task = this.tasks[id];
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: Date.now() });
    writeJson(this.tasksFile, this.tasks);
    return task;
  }
}