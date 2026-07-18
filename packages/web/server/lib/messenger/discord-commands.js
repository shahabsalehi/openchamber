/**
 * Native Discord application (slash) command registration for the OpenChamber agent bot.
 *
 * Without registering these, typing `/model` in Discord just sends literal text
 * and the interactive wizards (which fire on APPLICATION_COMMAND interactions)
 * never run. We register the full set against the bot's application on every
 * gateway READY so a fresh bot — or a bot that gained a new command after an
 * update — works out of the box with autocomplete suggestions and dropdowns.
 *
 * Registration is guild-scoped when a guildId is known (instant propagation),
 * otherwise global (can take up to an hour to appear). Both are idempotent:
 * Discord upserts by name, so re-registering on each connect is safe.
 */

const STRING_OPTION = 3;
export const DISCORD_APPLICATION_COMMAND_LIMIT = 100;

function clipDescription(value, fallback) {
  const text = String(value ?? '').trim() || fallback;
  return text.slice(0, 100);
}

export function sanitizeDiscordCommandName(name, suffix = '') {
  const suffixText = String(suffix ?? '').trim().toLowerCase();
  const maxBaseLength = Math.max(1, 32 - suffixText.length);
  const base = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, maxBaseLength)
    .replace(/^[-_]+|[-_]+$/g, '');
  if (!base) return null;
  const full = `${base}${suffixText}`;
  return /^[a-z0-9_-]{1,32}$/.test(full) ? full : null;
}

/**
 * The canonical OpenChamber agent slash command set. Descriptions are kept ≤ 100 chars
 * (Discord's hard limit). Commands backed by an interactive wizard
 * (`model`, `agent`, `verbosity`, `skill`) take no options — the dropdowns
 * collect everything. The rest map straight onto the text command pipeline.
 */
export function buildSlashCommandDefinitions() {
  return [
    { name: 'help', description: 'List OpenChamber agent messenger commands' },
    { name: 'status', description: 'Show the session, project, model and agent for this conversation' },
    {
      name: 'add-project',
      description: 'Register an existing project directory and bind this Discord channel',
      options: [
        { type: STRING_OPTION, name: 'path', description: 'Absolute project path, optionally followed by a label', required: true },
      ],
    },
    {
      name: 'create-new-project',
      description: 'Create an OpenChamber project folder and Discord project channel',
      options: [
        { type: STRING_OPTION, name: 'name', description: 'Project name or absolute path', required: true },
      ],
    },
    { name: 'remove-project', description: 'Unbind this Discord channel from its project without deleting files' },
    { name: 'abort', description: 'Stop the current OpenCode turn' },
    { name: 'new', description: 'Drop the current session and start fresh on the next message' },
    { name: 'undo', description: 'Revert one user message' },
    { name: 'redo', description: 'Step forward through undo' },
    { name: 'compact', description: 'Summarise + compact the session history (destructive)' },
    {
      name: 'summary',
      description: 'Write a non-destructive summary of the session',
      options: [
        { type: STRING_OPTION, name: 'topic', description: 'Optional topic to focus the summary on', required: false },
      ],
    },
    { name: 'init', description: 'Run OpenCode init (creates/updates AGENTS.md)' },
    { name: 'review', description: 'Run the OpenCode review workflow' },
    { name: 'diff', description: 'Show a reviewable git diff for this project/worktree' },
    {
      name: 'tunnel',
      description: 'Expose OpenChamber through the configured tunnel provider',
      options: [
        { type: STRING_OPTION, name: 'args', description: 'Optional provider/mode, e.g. cloudflare quick', required: false },
      ],
    },
    { name: 'login', description: 'Pick a provider auth method and open OpenCode login guidance' },
    { name: 'usage', description: 'Show estimated token usage for this session' },
    { name: 'credits', description: 'Alias for /usage — show session usage' },
    {
      name: 'shell',
      description: 'Run a shell command in the project and show its output',
      options: [
        { type: STRING_OPTION, name: 'command', description: 'The shell command to run (e.g. pwd)', required: true },
      ],
    },
    { name: 'model', description: 'Pick the model + thinking effort (this chat, project, or everywhere)' },
    { name: 'agent', description: 'Pick the agent for this conversation (or set a project default)' },
    { name: 'verbosity', description: 'Choose how much OpenChamber agent streams back (this chat, project, or everywhere)' },
    { name: 'yolo', description: 'Set tool permission mode: always ask / non-destructive / allow all' },
    { name: 'permissions', description: 'Synonym for /yolo — set tool permission mode' },
    { name: 'skill', description: 'Pick an available skill and hand it to the agent' },
    { name: 'sessions', description: 'List recent OpenCode sessions for this project' },
    {
      name: 'session',
      description: 'Start a new OpenCode session (and thread) with a prompt',
      options: [
        { type: STRING_OPTION, name: 'prompt', description: 'The task description for the AI', required: true },
      ],
    },
    {
      name: 'resume',
      description: 'Resume a previous session in a new thread',
      options: [
        { type: STRING_OPTION, name: 'session', description: 'List number or session id (leave empty to list)', required: false },
      ],
    },
    {
      name: 'fork',
      description: 'Branch the session from an earlier user message',
      options: [
        { type: STRING_OPTION, name: 'message', description: 'List number from /fork (leave empty to list)', required: false },
      ],
    },
    {
      name: 'btw',
      description: 'Ask a side question in a new forked thread without interrupting this run',
      options: [
        { type: STRING_OPTION, name: 'question', description: 'The side question for the forked thread', required: true },
      ],
    },
    { name: 'share', description: 'Generate a public URL for the current session' },
    { name: 'unshare', description: 'Revoke the public URL for the current session' },
    {
      name: 'queue',
      description: 'Queue a message to send after the current response finishes',
      options: [
        { type: STRING_OPTION, name: 'message', description: 'The message to queue', required: true },
      ],
    },
    {
      name: 'clear-queue',
      description: 'Clear all queued messages or one queued position',
      options: [
        { type: STRING_OPTION, name: 'position', description: 'Optional queue position to clear', required: false },
      ],
    },
    { name: 'mention-mode', description: 'Toggle mention-only mode for this channel' },
    {
      name: 'new-worktree',
      description: 'Create an isolated git worktree and work there in a new thread',
      options: [
        { type: STRING_OPTION, name: 'name', description: 'Worktree name (derived automatically when omitted)', required: false },
      ],
    },
    { name: 'worktrees', description: 'List git worktrees for this channel project' },
    {
      name: 'toggle-worktrees',
      description: 'Toggle auto-worktrees for new sessions in this project',
      options: [
        { type: STRING_OPTION, name: 'value', description: 'on or off (omit to toggle)', required: false },
      ],
    },
    { name: 'merge-worktree', description: 'Squash-merge this worktree into the default branch' },
    {
      name: 'mcp',
      description: 'List MCP servers or enable/disable a configured server',
      options: [
        { type: STRING_OPTION, name: 'args', description: 'connect <name> or disconnect <name>', required: false },
      ],
    },
    {
      name: 'add-dir',
      description: 'Check whether extra directory access grants are supported',
      options: [
        { type: STRING_OPTION, name: 'path', description: 'Absolute directory path', required: true },
      ],
    },
    { name: 'context-usage', description: 'Show token/context usage for this session' },
    { name: 'session-id', description: 'Show the current session id and Discord URL' },
    {
      name: 'schedule',
      description: 'Schedule a prompt: UTC ISO date or cron — list / delete <id> to manage',
      options: [
        { type: STRING_OPTION, name: 'args', description: '<when> [model=p/m] [agent=name] <prompt> | list | delete <id>', required: false },
      ],
    },
    {
      name: 'queue-command',
      description: 'Queue an OpenCode slash command after the current response',
      options: [
        { type: STRING_OPTION, name: 'command', description: 'OpenCode command name and optional args', required: true },
      ],
    },
    { name: 'fork-subagent', description: 'Explain current subagent fork support' },
    { name: 'restart-opencode-server', description: 'Reload/reconnect OpenChamber managed OpenCode server' },
  ].map((c) => ({ type: 1, ...c }));
}

export function buildDynamicSlashCommandDefinitions({
  commands = [],
  skills = [],
  existingNames = new Set(),
  remaining = DISCORD_APPLICATION_COMMAND_LIMIT,
} = {}) {
  const defs = [];
  const map = new Map();
  const used = new Set(existingNames);

  const add = ({ source, kind, suffix, description }) => {
    if (defs.length >= remaining) return;
    const originalName = typeof source?.name === 'string' ? source.name.trim() : '';
    if (!originalName) return;
    const name = sanitizeDiscordCommandName(originalName, suffix);
    if (!name || used.has(name)) return;
    used.add(name);
    defs.push({
      type: 1,
      name,
      description: clipDescription(source.description, description),
      ...(kind === 'cmd'
        ? {
            options: [
              { type: STRING_OPTION, name: 'args', description: 'Optional arguments for the OpenCode command', required: false },
            ],
          }
        : {}),
    });
    map.set(name, { kind, name: originalName });
  };

  for (const command of commands) {
    if (command?.source === 'skill') continue;
    add({
      source: command,
      kind: 'cmd',
      suffix: '-cmd',
      description: 'Run this OpenCode command in the current session',
    });
  }
  for (const skill of skills) {
    add({
      source: skill,
      kind: 'skill',
      suffix: '-skill',
      description: 'Hand this skill to OpenChamber agent',
    });
  }

  return { definitions: defs, commandMap: map };
}

export function buildApplicationCommandRegistration({ dynamic = {} } = {}) {
  const builtIns = buildSlashCommandDefinitions();
  const existingNames = new Set(builtIns.map((command) => command.name));
  const remaining = Math.max(0, DISCORD_APPLICATION_COMMAND_LIMIT - builtIns.length);
  const dynamicBuilt = buildDynamicSlashCommandDefinitions({
    commands: dynamic.commands ?? [],
    skills: dynamic.skills ?? [],
    existingNames,
    remaining,
  });
  const commands = [...builtIns, ...dynamicBuilt.definitions].slice(0, DISCORD_APPLICATION_COMMAND_LIMIT);
  return { commands, dynamicCommandMap: dynamicBuilt.commandMap };
}

/**
 * Register the OpenChamber agent slash commands against a bot application.
 *
 * @param {object} args
 * @param {(token, method, path, body) => Promise<{ok:boolean,status:number,body:any}>} args.restCall
 * @param {string} args.token        bot token
 * @param {string} args.applicationId  bot application id (equals the bot user id)
 * @param {string|null} [args.guildId]  register guild-scoped when set (instant)
 * @returns {Promise<{ ok: boolean, scope: 'guild'|'global', status?: number, error?: string }>}
 */
export async function registerApplicationCommands({ restCall, token, applicationId, guildId = null, dynamic = {} }) {
  if (!applicationId) return { ok: false, scope: 'global', error: 'no application id' };
  const { commands, dynamicCommandMap } = buildApplicationCommandRegistration({ dynamic });
  const scope = guildId ? 'guild' : 'global';
  const path = guildId
    ? `/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`
    : `/applications/${encodeURIComponent(applicationId)}/commands`;
  try {
    const r = await restCall(token, 'PUT', path, commands);
    if (!r.ok) {
      return {
        ok: false,
        scope,
        status: r.status,
        error: typeof r.body === 'string' ? r.body.slice(0, 300) : `HTTP ${r.status}`,
      };
    }
    return { ok: true, scope, status: r.status, dynamicCommandMap, commandCount: commands.length };
  } catch (err) {
    return { ok: false, scope, error: err?.message ?? 'registration failed' };
  }
}
