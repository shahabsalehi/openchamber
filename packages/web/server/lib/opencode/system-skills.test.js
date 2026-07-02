import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildSystemSkills, syncSystemSkills } from './system-skills.js';
import { parseMdFile, writeMdFile } from './shared.js';

const API_BASE = 'http://127.0.0.1:3001';

describe('system-skills', () => {
  let skillRootDir;

  beforeEach(() => {
    skillRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-system-skills-'));
  });

  afterEach(() => {
    fs.rmSync(skillRootDir, { recursive: true, force: true });
  });

  it('builds the create-project skill with the API base URL embedded', () => {
    const skills = buildSystemSkills({ apiBaseUrl: API_BASE });
    const createProject = skills.find((s) => s.name === 'create-project');
    expect(createProject).toBeTruthy();
    expect(createProject.frontmatter['managed-by']).toBe('openchamber');
    expect(createProject.frontmatter.description).toMatch(/new project/i);
    expect(createProject.body).toContain(`${API_BASE}/api/otto/messenger/agent/create-project`);
    expect(createProject.body).toContain('AGENTS.md');
    expect(createProject.body).toContain('Discord');
  });

  it('installs a missing system skill', () => {
    const results = syncSystemSkills({ apiBaseUrl: API_BASE, skillRootDir });
    expect(results).toEqual([
      {
        name: 'create-project',
        path: path.join(skillRootDir, 'create-project', 'SKILL.md'),
        action: 'installed',
      },
    ]);
    const { frontmatter, body } = parseMdFile(results[0].path);
    expect(frontmatter.name).toBe('create-project');
    expect(frontmatter['managed-by']).toBe('openchamber');
    expect(body).toContain(API_BASE);
  });

  it('is a no-op when the managed skill is already current', () => {
    syncSystemSkills({ apiBaseUrl: API_BASE, skillRootDir });
    const results = syncSystemSkills({ apiBaseUrl: API_BASE, skillRootDir });
    expect(results[0].action).toBe('unchanged');
  });

  it('rewrites the managed skill when the API base URL changes', () => {
    syncSystemSkills({ apiBaseUrl: API_BASE, skillRootDir });
    const results = syncSystemSkills({ apiBaseUrl: 'http://127.0.0.1:4999', skillRootDir });
    expect(results[0].action).toBe('updated');
    const { body } = parseMdFile(results[0].path);
    expect(body).toContain('http://127.0.0.1:4999');
    expect(body).not.toContain(API_BASE);
  });

  it('never touches a user-owned skill without the managed-by marker', () => {
    const skillDir = path.join(skillRootDir, 'create-project');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    writeMdFile(
      skillPath,
      { name: 'create-project', description: 'my customized version' },
      'user content',
    );
    const results = syncSystemSkills({ apiBaseUrl: API_BASE, skillRootDir });
    expect(results[0].action).toBe('skipped-user-owned');
    const { frontmatter, body } = parseMdFile(skillPath);
    expect(frontmatter.description).toBe('my customized version');
    expect(body).toBe('user content');
  });
});
