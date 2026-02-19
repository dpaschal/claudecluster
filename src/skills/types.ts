export interface Skill {
  name: string;
  description: string;
  content: string;
  triggers?: string[];
  filePath: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  triggers?: string[];
}
