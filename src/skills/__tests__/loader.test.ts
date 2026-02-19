import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SkillLoader } from '../loader.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('SkillLoader', () => {
  let tmpDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    loader = new SkillLoader([tmpDir]);
  });

  afterEach(async () => {
    loader.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should load a SKILL.md file', async () => {
    await fs.writeFile(path.join(tmpDir, 'greeting.md'), `---
name: greeting
description: Greet the user warmly
triggers:
  - hello
  - hi
  - hey
---

# Greeting Skill

When triggered, respond with a warm, friendly greeting.
`);

    await loader.loadAll();
    const skills = loader.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('greeting');
    expect(skills[0].description).toBe('Greet the user warmly');
    expect(skills[0].triggers).toContain('hello');
  });

  it('should load multiple skills from a directory', async () => {
    await fs.writeFile(path.join(tmpDir, 'skill1.md'), `---\nname: skill1\ndescription: First skill\n---\nContent 1`);
    await fs.writeFile(path.join(tmpDir, 'skill2.md'), `---\nname: skill2\ndescription: Second skill\n---\nContent 2`);

    await loader.loadAll();
    expect(loader.listSkills()).toHaveLength(2);
  });

  it('should get a skill by name', async () => {
    await fs.writeFile(path.join(tmpDir, 'test.md'), `---\nname: test-skill\ndescription: A test skill\n---\nTest content here.`);

    await loader.loadAll();
    const skill = loader.getSkill('test-skill');
    expect(skill).toBeDefined();
    expect(skill!.content).toContain('Test content here.');
  });

  it('should return undefined for unknown skill', async () => {
    await loader.loadAll();
    expect(loader.getSkill('nonexistent')).toBeUndefined();
  });

  it('should skip files without valid frontmatter', async () => {
    await fs.writeFile(path.join(tmpDir, 'bad.md'), 'No frontmatter here');
    await loader.loadAll();
    expect(loader.listSkills()).toHaveLength(0);
  });

  it('should load from multiple directories', async () => {
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test2-'));
    const multiLoader = new SkillLoader([tmpDir, tmpDir2]);

    await fs.writeFile(path.join(tmpDir, 's1.md'), `---\nname: s1\ndescription: d1\n---\nc1`);
    await fs.writeFile(path.join(tmpDir2, 's2.md'), `---\nname: s2\ndescription: d2\n---\nc2`);

    await multiLoader.loadAll();
    expect(multiLoader.listSkills()).toHaveLength(2);

    multiLoader.stop();
    await fs.rm(tmpDir2, { recursive: true, force: true });
  });
});
