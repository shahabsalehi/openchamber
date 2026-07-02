import fs from 'fs';
import path from 'path';
import { SKILL_DIR, parseMdFile, writeMdFile } from './shared.js';

/**
 * OpenChamber-managed "system" skills.
 *
 * These skills ship with the OpenChamber server and are installed into the
 * user-level OpenCode skill directory (`~/.config/opencode/skills/<name>/`)
 * at startup so the agent can load them natively in every project — web,
 * desktop, and the Discord bridge all discover them through the same
 * skill-discovery paths OpenCode itself scans.
 *
 * Ownership contract: a system skill carries `managed-by: openchamber` in its
 * frontmatter and is refreshed on every server start (content is regenerated
 * with the current local API base URL). A skill file WITHOUT that marker is
 * user-owned and is never touched — users who want to customize a system
 * skill can simply remove the marker to take ownership.
 */

const MANAGED_BY_KEY = 'managed-by';
const MANAGED_BY_VALUE = 'openchamber';

/**
 * The `create-project` system skill — bootstraps a brand-new OpenChamber
 * project from inside a conversation: create/scaffold the folder, register it
 * with OpenChamber, write an AGENTS.md, and mirror it into Discord as a
 * channel the user can immediately chat in.
 */
function buildCreateProjectSkill({ apiBaseUrl }) {
  const api = `${apiBaseUrl}/api/otto/messenger/agent`;
  const body = [
    '# Create a new OpenChamber project',
    '',
    'Use this skill when the user asks to create, bootstrap, scaffold, or clone a **new project** (a new folder / repository / workspace that should become its own OpenChamber project with its own Discord channel).',
    '',
    'This skill file is managed by OpenChamber and refreshed on server start. Remove the `managed-by` frontmatter field to take ownership of your edits.',
    '',
    '## Workflow',
    '',
    '### 1. Resolve the target location — ask, never guess',
    '',
    '- If the user already told you where to create the project (a folder or parent directory), use it. Resolve to an **absolute path**.',
    '- If the user did **not** specify a location, you MUST ask before creating anything. Suggest the OpenChamber projects root (`~/.config/openchamber/projects/<name>`) as the default and let the user confirm or provide a different folder.',
    '- Also confirm the project name if it is not obvious from the request.',
    '',
    '### 2. Create the project folder',
    '',
    'Pick the simplest path that matches the request:',
    '',
    '- **Empty project**: `mkdir -p <abs-path>` (optionally `git init`).',
    '- **Framework project**: use the official scaffolding CLI non-interactively (for example `npm create vite@latest <name> -- --template react-ts`, `cargo new <name>`, `uv init <name>`). Run it so the target folder ends up at the confirmed absolute path.',
    '- **Clone an existing repository**: skip this step — the registration endpoint below can clone for you (`action: "clone"`).',
    '',
    '### 3. Register the project with OpenChamber (auto-creates the Discord channel)',
    '',
    'Call the local OpenChamber API with bash curl. This registers the project so it appears in the OpenChamber UI **and**, when Discord is connected, finds-or-creates a Discord channel bound to the project:',
    '',
    '```bash',
    '# Folder you created in step 2 (or any existing directory):',
    `curl -s -X POST ${api}/create-project -H 'Content-Type: application/json' \\`,
    '  -d \'{"action":"path","path":"<abs-path>","label":"<Project Name>"}\'',
    '',
    '# Let the server create an empty directory for you (path optional):',
    `curl -s -X POST ${api}/create-project -H 'Content-Type: application/json' \\`,
    '  -d \'{"action":"new","path":"<abs-path>","label":"<Project Name>"}\'',
    '',
    '# Clone a git repository as the new project:',
    `curl -s -X POST ${api}/create-project -H 'Content-Type: application/json' \\`,
    '  -d \'{"action":"clone","url":"<git-url>","path":"<optional-abs-dest>","label":"<Project Name>"}\'',
    '```',
    '',
    'The response contains `project` (`{ id, path, label }`) and `discord` (`{ ok, channelId, channelName, url }` on success, or `{ ok: false, error }` when Discord is unavailable). Project registration and the Discord channel are independent: a Discord failure never rolls back the project — report it instead.',
    '',
    '### 4. Create AGENTS.md for the new project',
    '',
    '- Ask the user what kind of AGENTS.md the new project should have. Propose a concrete draft derived from:',
    '  - the **conversation context** (what the project is for, stack, conventions discussed), and',
    '  - the **AGENTS.md of the current project** you are running in — read it from the current working directory (or its worktree root) and reuse the sections that transfer (tooling, code style, validation commands), dropping anything project-specific that does not apply.',
    '- If the current project has no AGENTS.md, propose a minimal one: purpose, tech stack, build/test commands, and code conventions.',
    '- After the user confirms (or asks you to just do it), write `AGENTS.md` into the new project root.',
    '',
    '### 5. Report back',
    '',
    'Tell the user, in one compact message:',
    '',
    '- the absolute path of the new project and what was scaffolded,',
    '- that it is registered in OpenChamber (it appears in the project switcher),',
    '- the Discord channel: include `discord.url` from the response and say they can **start chatting in that channel right away** — messages there open sessions in the new project. If `discord.ok` is false, say the channel was not created and include the error.',
    '',
    '## Rules',
    '',
    '- Never create the project in a location the user did not confirm.',
    '- Never ask for or handle the Discord bot token — the server resolves it internally.',
    '- Use absolute paths in every API call.',
    '- If curl fails because the OpenChamber API is unreachable, report the error instead of silently skipping registration.',
  ].join('\n');

  return {
    name: 'create-project',
    frontmatter: {
      name: 'create-project',
      description:
        'Use when the user asks to create, bootstrap, scaffold, or clone a NEW project (new folder/repo/workspace). Creates the folder (CLI/scaffold/clone), registers it as an OpenChamber project, writes an AGENTS.md based on the conversation and the current AGENTS.md, and links a Discord channel the user can immediately chat in.',
      [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
    },
    body,
  };
}

/** Build every OpenChamber system skill for the given local API base URL. */
export function buildSystemSkills({ apiBaseUrl }) {
  return [buildCreateProjectSkill({ apiBaseUrl })];
}

/**
 * Install or refresh the OpenChamber system skills in the user skill dir.
 *
 * - Missing skill → installed.
 * - Existing skill with the `managed-by: openchamber` marker → rewritten when
 *   the generated content differs (e.g. the server port changed).
 * - Existing skill WITHOUT the marker → left untouched (user-owned).
 *
 * Returns per-skill results: { name, path, action } with action one of
 * 'installed' | 'updated' | 'unchanged' | 'skipped-user-owned'.
 */
export function syncSystemSkills({ apiBaseUrl, skillRootDir = SKILL_DIR }) {
  const results = [];
  for (const skill of buildSystemSkills({ apiBaseUrl })) {
    const skillDir = path.join(skillRootDir, skill.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    let action = 'installed';

    if (fs.existsSync(skillPath)) {
      let existing = { frontmatter: {}, body: '' };
      try {
        existing = parseMdFile(skillPath);
      } catch {
        // unreadable file — treat as user-owned rather than clobbering it
        results.push({ name: skill.name, path: skillPath, action: 'skipped-user-owned' });
        continue;
      }
      if (existing.frontmatter?.[MANAGED_BY_KEY] !== MANAGED_BY_VALUE) {
        results.push({ name: skill.name, path: skillPath, action: 'skipped-user-owned' });
        continue;
      }
      const sameBody = existing.body === skill.body.trim();
      const sameDescription =
        existing.frontmatter?.description === skill.frontmatter.description;
      if (sameBody && sameDescription) {
        results.push({ name: skill.name, path: skillPath, action: 'unchanged' });
        continue;
      }
      action = 'updated';
    }

    fs.mkdirSync(skillDir, { recursive: true });
    writeMdFile(skillPath, skill.frontmatter, skill.body);
    results.push({ name: skill.name, path: skillPath, action });
  }
  return results;
}
