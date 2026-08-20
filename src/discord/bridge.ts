import {
  Client,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ApplicationCommandOptionType,
  type Message,
  type ApplicationCommandData,
} from "discord.js";
import { config } from "../config.js";
import { Store, type TaskRecord } from "../store.js";
import { TaskEngine, type PendingApproval } from "../codex/taskEngine.js";

type ApprovalAction = "approve" | "approveSession" | "decline";

const statusColor: Record<string, number> = {
  running: 0x3b82f6,
  awaitingApproval: 0xf59e0b,
  completed: 0x22c55e,
  failed: 0xef4444,
  interrupted: 0x6b7280,
};

const statusLabel: Record<string, string> = {
  running: "Running",
  awaitingApproval: "Awaiting approval",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class Bridge {
  client: Client | null = null;
  private dmChannels = new Map<string, Message["channel"]>();
  private approvalMessages = new Map<string, { channelId: string; messageId: string }>();
  private handledApprovals = new Set<string>();
  private taskMessages = new Map<string, { channelId: string; messageId: string }>();
  private cmdNames = new Set<string>();

  constructor(private store: Store) {}

  private engine: TaskEngine | null = null;

  async login(): Promise<void> {
    this.buildClient();
    try {
      await this.client!.login(config.discordToken);
    } catch (err) {
      this.client?.destroy().catch(() => undefined);
      this.client = null;
      throw err;
    }
  }

  private buildClient(): void {
    if (this.client) return;
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
    });
    client.on("ready", () => this.onReady(client));
    client.on("interactionCreate", (i) => this.onInteraction(i as never));
    this.client = client;
  }

  /** Subscribe this bridge to a (fresh) task engine. */
  attach(engine: TaskEngine): void {
    this.engine = engine;
    engine.on("taskStarted", (task) => void this.onTaskStarted(task));
    engine.on("approval", (pending) => void this.onApproval(pending));
    engine.on("approvalResolved", (e) => void this.onApprovalResolved(e));
    engine.on("taskDone", (task) => void this.onTaskDone(task));
    engine.on("warning", (taskId, message) =>
      void this.dmTaskOwner(taskId, { title: "⚠️ Codex warning", description: truncate(message, 4000) }),
    );
  }

  private async onReady(client: Client): Promise<void> {
    const commands: ApplicationCommandData[] = [
      {
        name: "invite",
        description: "Get the invite link to add the bot to your server (needed for DMs)",
      },
      {
        name: "login",
        description: "Get your one-link web-auth URL (optional)",
      },
      {
        name: "run",
        description: "Start a codex task (you get approvals in DMs)",
        options: [
          {
            name: "prompt",
            description: "What should codex do?",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "cwd",
            description: "Working directory for the task (defaults to DEFAULT_CWD)",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      },
      {
        name: "status",
        description: "Show your recent codex tasks",
      },
      {
        name: "approvals",
        description: "Show tasks currently waiting on your approval",
      },
      {
        name: "stop",
        description: "Interrupt a running task",
        options: [
          {
            name: "task",
            description: "Task id (defaults to your most recent active task)",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      },
      {
        name: "testnotify",
        description: "Send a test notification to your DMs to verify the pipeline",
      },
    ];
    try {
      await client.application?.commands.set(commands);
      this.cmdNames = new Set(commands.map((c) => c.name));
      console.log(`[discord] ready as ${client.user?.tag}, ${commands.length} commands registered`);
    } catch (err) {
      console.error("[discord] command registration failed:", (err as Error).message);
    }
  }

  // ---- interactions ----

  private async onInteraction(interaction: any): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        await this.onCommand(interaction);
      } else if (interaction.isButton()) {
        await this.onButton(interaction);
      }
    } catch (err) {
      console.error("[discord] interaction error:", err);
      const message = (err as Error).message ?? "Something went wrong";
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `❌ ${message}`, ephemeral: true }).catch(() => undefined);
      } else {
        await interaction.reply({ content: `❌ ${message}`, ephemeral: true }).catch(() => undefined);
      }
    }
  }

  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const user = interaction.user;

    switch (interaction.commandName) {
      case "invite": {
        await interaction.reply({
          content: `🤖 **Add the bot to your server** (needed so I can DM you approvals)\n${this.inviteUrl()}\n\nPick your server from the dropdown and authorize.`,
          ephemeral: true,
        });
        return;
      }
      case "login": {
        if (this.isLinked(user.id)) {
          await interaction.reply({
            content: `✅ You're already linked as **${user.username}**. No web link needed — just use \`/run\`.`,
            ephemeral: true,
          });
          return;
        }
        const url = this.oauthUrl();
        await interaction.reply({
          content: `🔗 **Link your account**\nOptional: open this URL once to authenticate via the web:\n${url}\n\n(Or just use \`/run\` — your Discord id is auto-linked from here.)`,
          ephemeral: true,
        });
        return;
      }
      case "run": {
        if (!this.ensureLinked(interaction)) return;
        const prompt = interaction.options.getString("prompt", true);
        const cwd = interaction.options.getString("cwd") ?? undefined;
        await interaction.deferReply({ ephemeral: true });
        const task = await (this.engine as TaskEngine).startTask({ discordUserId: user.id, prompt, cwd });
        await interaction.editReply({
          content: `✅ Task \`${task.id}\` started — approvals and results will arrive in your DMs.\n📄 \`${truncate(prompt, 200)}\``,
        });
        return;
      }
      case "status": {
        if (!this.ensureLinked(interaction)) return;
        const tasks = this.store.listTasks(user.id).slice(0, 10);
        const embed = this.buildStatusEmbed(tasks, user.displayName);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
      case "approvals": {
        if (!this.ensureLinked(interaction)) return;
        const pending = this.store
          .listTasks(user.id)
          .filter((t) => t.status === "awaitingApproval")
          .map((t) => (this.engine as TaskEngine).getPending(t.id))
          .flat();
        if (pending.length === 0) {
          await interaction.reply({ content: "Nothing waiting on your approval right now. ✅", ephemeral: true });
          return;
        }
        const embed = new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle(`⏳ ${pending.length} pending approval${pending.length === 1 ? "" : "s"}`)
          .setDescription(
            pending.map((p) => `- \`${p.taskId}\`: ${this.approvalSummary(p)}`).join("\n"),
          );
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
      case "stop": {
        if (!this.ensureLinked(interaction)) return;
        const requested = interaction.options.getString("task");
        let task: TaskRecord | null =
          (requested && this.store.getTask(requested)) ||
          this.store.listTasks(user.id).find((t) => t.status === "running" || t.status === "awaitingApproval") ||
          null;
        if (!task) {
          await interaction.reply({ content: "No active task found to stop.", ephemeral: true });
          return;
        }
        if (task.discordUserId !== user.id) {
          await interaction.reply({ content: "That task does not belong to you.", ephemeral: true });
          return;
        }
        task = await (this.engine as TaskEngine).stopTask(task.id);
        await interaction.reply({ content: `⏹ Stopped \`${task!.id}\`.`, ephemeral: true });
        return;
      }
      case "testnotify": {
        if (!this.ensureLinked(interaction)) return;
        await this.dmUser(
          user.id,
          {
            title: "🔔 Test notification",
            description: `Hey **${user.username}** — this is a test notification from Codex Relay.\n\nThe Discord → Codex connection is live. Now try \`/run\` with a real task.`,
          },
        );
        await interaction.reply({ content: "✅ Test notification sent to your DMs. Check the DM I just sent you.", ephemeral: true });
        return;
      }
      default:
        await interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  }

  private async onButton(interaction: MessageComponentInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith("ap:")) {
      await interaction.reply({ content: "Unknown button.", ephemeral: true });
      return;
    }
    const [, kindRaw, taskId, reqId] = customId.split(":");
    const action = (kindRaw.split("|")[1] as ApprovalAction) ?? "approve";

    const task = this.store.getTask(taskId);
    if (!task) {
      await interaction.reply({ content: "This task no longer exists.", ephemeral: true });
      return;
    }
    if (task.discordUserId !== interaction.user.id) {
      await interaction.reply({ content: "This approval belongs to another user.", ephemeral: true });
      return;
    }

    const label = action === "approve" ? "approved" : action === "approveSession" ? "approved for session" : "declined";

    this.handledApprovals.add(String(reqId));
    const resolved = (this.engine as TaskEngine).resolveApproval(taskId, reqId, this.decisionFor(taskId, reqId, action), label);
    this.approvalMessages.delete(String(reqId));

    await interaction
      .update({
        embeds: interaction.message.embeds.map((e) => EmbedBuilder.from(e as never).setFooter({ text: `${resolved ? "✅" : "⚠️"} ${label}` })),
        components: interaction.message.components.map((row) =>
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            (row as any).components.map((c: any) => ButtonBuilder.from(c as never).setDisabled(true) as ButtonBuilder),
          ),
        ),
      })
      .catch((err) => console.error("[discord] failed to update approval button message:", (err as Error).message));
  }

  private decisionFor(taskId: string, reqId: string, action: ApprovalAction): unknown {
    const pending = (this.engine as TaskEngine).getPending(taskId).find((p) => String(p.requestId) === String(reqId));
    if (!pending) return { decision: "decline" };
    if (pending.kind === "permissions") {
      const granted = action === "decline" ? {} : { network: pending.params.permissions?.network, fileSystem: pending.params.permissions?.fileSystem };
      return { permissions: granted, scope: action === "approveSession" ? "session" : "turn" };
    }
    const decision = action === "approve" ? "accept" : action === "approveSession" ? "acceptForSession" : "decline";
    return { decision };
  }

  // ---- task events ----

  private async onTaskStarted(task: TaskRecord): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(statusColor.running)
      .setTitle("🎯 Codex task started")
      .setDescription(truncate(task.prompt, 2000))
      .addFields(
        { name: "Task", value: `\`${task.id}\``, inline: true },
        { name: "Status", value: "Running", inline: true },
        { name: "Working directory", value: `\`${task.cwd}\`` },
      )
      .setFooter({ text: "Approval requests from codex will appear below." })
      .setTimestamp();
    const sent = await this.dmOrThrow(task.discordUserId, { embeds: [embed] });
    if (sent) {
      this.taskMessages.set(task.id, { channelId: sent.channelId, messageId: sent.id });
    }
  }

  private async onApproval(pending: PendingApproval): Promise<void> {
    const embed = this.buildApprovalEmbed(pending);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ap:${pending.kind}:${pending.taskId}:${pending.requestId}`).setLabel("✓ Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`ap:${pending.kind}|session:${pending.taskId}:${pending.requestId}`)
        .setLabel("✓ Approve session")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ap:${pending.kind}|decline:${pending.taskId}:${pending.requestId}`).setLabel("✕ Decline").setStyle(ButtonStyle.Danger),
    );
    const sent = await this.dmOrThrow(pending.task.discordUserId, { embeds: [embed], components: [row] });
    if (sent) {
      this.approvalMessages.set(String(pending.requestId), { channelId: sent.channelId, messageId: sent.id });
    }
  }

  private async onApprovalResolved(e: { requestId: number | string; taskId: string; label: string }): Promise<void> {
    const reqKey = String(e.requestId);
    if (this.handledApprovals.has(reqKey)) return;
    const ref = this.approvalMessages.get(reqKey);
    if (!ref) return;
    try {
      const channel = await this.client!.channels.fetch(ref.channelId);
      if (!channel || !("messages" in channel)) return;
      const message = await channel.messages.fetch(ref.messageId);
      const label = `✅ ${e.label}`;
      await message.edit({
        embeds: message.embeds.map((embed) => EmbedBuilder.from(embed as never).setFooter({ text: label })),
        components: message.components.map((row) =>
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            (row as any).components.map((c: any) => ButtonBuilder.from(c as never).setDisabled(true) as ButtonBuilder),
          ),
        ),
      });
      this.approvalMessages.delete(reqKey);
    } catch (err) {
      console.error("[discord] failed to update approval message:", (err as Error).message);
    }
  }

  private async onTaskDone(task: TaskRecord): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(statusColor[task.status] ?? statusColor.failed)
      .setTitle(this.doneTitle(task.status))
      .setDescription(truncate(task.finalText ?? task.prompt, 2000))
      .addFields(
        { name: "Task", value: `\`${task.id}\``, inline: true },
        { name: "Status", value: statusLabel[task.status] ?? task.status, inline: true },
        { name: "Prompt", value: truncate(task.prompt, 500) },
      );
    if (task.error) embed.addFields({ name: "Error", value: truncate(task.error, 1000) });
    embed.setTimestamp();
    await this.dmOrThrow(task.discordUserId, { embeds: [embed] });
  }

  private buildStatusEmbed(tasks: TaskRecord[], displayName: string): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(`Your codex tasks${displayName ? ` (${displayName})` : ""}`)
      .setTimestamp();
    if (tasks.length === 0) {
      embed.setDescription("No tasks yet. Run one with `/run`.");
      return embed;
    }
    embed.setDescription(
      tasks
        .map((t) => {
          const icon = t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : t.status === "interrupted" ? "⏹" : t.status === "awaitingApproval" ? "⏳" : "🔄";
          return `${icon} \`${t.id}\` — ${statusLabel[t.status] ?? t.status}\n    ${truncate(t.prompt, 80)}`;
        })
        .join("\n") || "No tasks.",
    );
    return embed;
  }

  // ---- helpers ----

  private buildApprovalEmbed(pending: PendingApproval): EmbedBuilder {
    const p = pending.params;
    const embed = new EmbedBuilder().setColor(statusColor.awaitingApproval).setTimestamp(p.startedAt ?? Date.now());

    switch (pending.kind) {
      case "command": {
        embed.setTitle("🔧 Codex wants to run a command");
        if (p.networkApprovalContext) {
          embed.setDescription(
            `Network access to **\`${p.networkApprovalContext.protocol ?? "?"}://${p.networkApprovalContext.host ?? "?"}\`**\n${p.reason ? `*${p.reason}*` : ""}`,
          );
        } else if (p.command) {
          embed.setDescription(`\`\`\`bash\n${truncate(p.command, 1900)}\n\`\`\``);
        } else {
          embed.setDescription(p.reason ?? "A command wants approval.");
        }
        if (p.cwd) embed.addFields({ name: "Directory", value: `\`${p.cwd}\``, inline: true });
        if (p.reason && !p.networkApprovalContext) embed.addFields({ name: "Reason", value: truncate(p.reason, 900), inline: false });
        break;
      }
      case "fileChange": {
        embed.setTitle("📝 Codex wants to change files");
        const files = this.describeFiles(p.itemId);
        embed.setDescription(files ?? p.reason ?? "Codex would like to modify files.");
        if (p.grantRoot) embed.addFields({ name: "Grant root", value: `\`${p.grantRoot}\`` });
        if (p.reason) embed.addFields({ name: "Reason", value: truncate(p.reason, 900) });
        break;
      }
      case "permissions": {
        embed.setTitle("🔓 Codex requests permissions");
        const parts: string[] = [];
        parts.push(`**Reason:** ${p.reason || "none"}`);
        const net = p.permissions?.network;
        if (net) parts.push(`**Network:** \`${JSON.stringify(net).slice(0, 500)}\``);
        const fs = p.permissions?.fileSystem;
        if (fs) parts.push(`**Filesystem:** \`${JSON.stringify(fs).slice(0, 500)}\``);
        embed.setDescription(parts.join("\n"));
        break;
      }
    }

    embed.addFields({ name: "Task", value: `\`${pending.taskId}\``, inline: true });
    embed.setFooter({ text: "Tap Approve to continue, Decline to block this action." });
    return embed;
  }

  private describeFiles(itemId: string): string | null {
    const snapshot = (this.engine as TaskEngine).getItemSnapshot(itemId);
    const changes = snapshot?.changes;
    if (!Array.isArray(changes) || changes.length === 0) return null;
    return changes
      .map((c: any) => {
        const kind = typeof c.kind === "string" ? c.kind : c.kind?.type ?? "change";
        return `- \`${kind}\` ${c.path}`;
      })
      .join("\n");
  }

  private approvalSummary(p: PendingApproval): string {
    if (p.kind === "command") return truncate((p.params.command ?? p.params.reason ?? "command") as string, 60);
    return p.kind;
  }

  private doneTitle(status: string): string {
    switch (status) {
      case "completed":
        return "✅ Codex task complete";
      case "failed":
        return "❌ Codex task failed";
      case "interrupted":
        return "⏹ Codex task stopped";
      default:
        return "Codex task updated";
    }
  }

  // ---- DM helpers ----

  private isLinked(discordId: string): boolean {
    return this.store.getUser(discordId) !== null;
  }

  /**
   * Auto-link the interacting Discord user from their Discord identity — no
   * web URL / OAuth needed. Answers denied reply when allowlist forbids them.
   */
  private ensureLinked(interaction: ChatInputCommandInteraction): boolean {
    const u = interaction.user;
    if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(u.id)) {
      void interaction.reply({ content: "🚫 Your Discord account is not on the allowlist.", ephemeral: true });
      return false;
    }
    if (!this.store.getUser(u.id)) {
      this.store.upsertUser({
        id: u.id,
        username: u.username,
        globalName: u.globalName ?? null,
        avatarUrl: u.displayAvatarURL({ size: 64 }),
        linkedAt: Date.now(),
      });
    }
    return true;
  }

  private async dmOrThrow(discordId: string, payload: any): Promise<Message | null> {
    try {
      const user = await this.client!.users.fetch(discordId);
      const channel = this.dmChannels.get(discordId) ?? (await user.createDM());
      this.dmChannels.set(discordId, channel);
      return (await (channel as any).send(payload)) as Message;
    } catch (err) {
      console.error(`[discord] failed to DM user ${discordId}:`, (err as Error).message);
      return null;
    }
  }

  private async dmTaskOwner(taskId: string | null, payload: { title?: string; description?: string }): Promise<void> {
    let discordId: string | undefined;
    if (taskId) discordId = this.store.getTask(taskId)?.discordUserId;
    if (!discordId) return;
    await this.dmUser(discordId, payload);
  }

  async dmUser(discordId: string, payload: { title?: string; description?: string }): Promise<void> {
    const embed = new EmbedBuilder().setColor(0x10b981).setTimestamp();
    if (payload.title) embed.setTitle(payload.title);
    if (payload.description) embed.setDescription(truncate(payload.description, 4000));
    await this.dmOrThrow(discordId, { embeds: [embed] });
  }

  oauthUrl(): string {
    const query = new URLSearchParams({
      client_id: config.discordClientId,
      response_type: "code",
      redirect_uri: config.redirectUri,
      scope: "identify",
    });
    return `https://discord.com/api/oauth2/authorize?${query.toString()}`;
  }

  inviteUrl(): string {
    // Send Messages + Embed Links. Bot must share a server with you so DMs work.
    const query = new URLSearchParams({
      client_id: config.discordClientId,
      permissions: String(0x800 | 0x4000),
      scope: "bot applications.commands",
    });
    return `https://discord.com/api/oauth2/authorize?${query.toString()}`;
  }
}