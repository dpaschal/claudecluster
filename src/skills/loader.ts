import * as fs from 'fs/promises';
import * as path from 'path';
import type { Skill, SkillFrontmatter } from './types.js';

export class SkillLoader {
  private directories: string[];
  private skills: Map<string, Skill> = new Map();
  private watchers: Array<{ close(): void }> = [];

  constructor(directories: string[]) {
    this.directories = directories;
  }

  async loadAll(): Promise<void> {
    this.skills.clear();

    for (const dir of this.directories) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const filePath = path.join(dir, file);
          await this.loadSkillFile(filePath);
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
  }

  private async loadSkillFile(filePath: string): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = this.parseFrontmatter(raw);
    if (!parsed) return;

    const { frontmatter, content } = parsed;
    if (!frontmatter.name || !frontmatter.description) return;

    this.skills.set(frontmatter.name, {
      name: frontmatter.name,
      description: frontmatter.description,
      content: content.trim(),
      triggers: frontmatter.triggers,
      filePath,
    });
  }

  private parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; content: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return null;

    const yamlBlock = match[1];
    const content = match[2];

    const frontmatter: Record<string, unknown> = {};
    let currentKey = '';
    let inArray = false;
    const arrayItems: string[] = [];

    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (inArray && trimmed.startsWith('- ')) {
        arrayItems.push(trimmed.slice(2).trim());
        continue;
      }

      if (inArray) {
        frontmatter[currentKey] = [...arrayItems];
        arrayItems.length = 0;
        inArray = false;
      }

      const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        if (value === '') {
          currentKey = key;
          inArray = true;
        } else {
          frontmatter[key] = value;
        }
      }
    }

    if (inArray) {
      frontmatter[currentKey] = [...arrayItems];
    }

    return {
      frontmatter: frontmatter as unknown as SkillFrontmatter,
      content,
    };
  }

  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
