// RequirementStore — file-based persistence for requirement documents
// Stored as Markdown files in .zelto/requirements/<id>.md with YAML frontmatter

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RequirementDoc, RequirementStatus, RequirementSummary } from './types.js';

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export class RequirementStore {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'requirements');
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private docToMarkdown(doc: RequirementDoc): string {
    const fm = [
      '---',
      `id: ${doc.id}`,
      `title: ${doc.title}`,
      `status: ${doc.status}`,
      `supersedes: ${doc.supersedes ?? ''}`,
      `createdAt: ${doc.createdAt}`,
      `confirmedAt: ${doc.confirmedAt ?? ''}`,
      '---',
      '',
    ].join('\n');

    const body = [
      `# ${doc.title}`,
      '',
      '## 用户输入',
      '',
      doc.userInput,
      '',
      '## 验收标准',
      '',
      ...doc.acceptanceCriteria.map((c) => `- ${c}`),
      '',
      '## AI 生成规格',
      '',
      doc.spec,
      '',
    ].join('\n');

    return fm + body;
  }

  private markdownToDoc(content: string): RequirementDoc {
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) throw new Error('Invalid requirement document format');

    const fmLines = match[1].split('\n');
    const body = match[2];

    const fm: Record<string, string> = {};
    for (const line of fmLines) {
      const idx = line.indexOf(': ');
      if (idx > 0) {
        fm[line.slice(0, idx).trim()] = line.slice(idx + 2).trim();
      }
    }

    // Extract acceptance criteria from body
    const criteriaLines = body.split('\n').filter((l) => l.trim().startsWith('- '));
    // Skip the first few - lines that are not acceptance criteria
    const acceptanceCriteria = criteriaLines
      .filter((l) => !l.startsWith('---'))
      .map((l) => l.trim().slice(2));

    // Extract user input from body
    const userInputMatch = body.match(/## 用户输入\n\n([\s\S]*?)\n\n## /);
    const userInput = userInputMatch ? userInputMatch[1].trim() : '';

    // Extract spec (everything after "## AI 生成规格")
    const specMatch = body.match(/## AI 生成规格\n\n([\s\S]*)$/);
    const spec = specMatch ? specMatch[1].trim() : '';

    return {
      id: fm.id ?? 'unknown',
      title: fm.title ?? 'Untitled',
      userInput,
      spec,
      status: (fm.status as RequirementStatus) ?? 'draft',
      supersedes: fm.supersedes && fm.supersedes !== '' ? fm.supersedes : null,
      acceptanceCriteria,
      createdAt: fm.createdAt ?? new Date().toISOString(),
      confirmedAt: fm.confirmedAt && fm.confirmedAt !== '' ? fm.confirmedAt : null,
    };
  }

  async save(doc: RequirementDoc): Promise<void> {
    this.ensureDir();
    const filePath = join(this.dir, `${doc.id}.md`);
    writeFileSync(filePath, this.docToMarkdown(doc), 'utf-8');
  }

  async read(id: string): Promise<RequirementDoc> {
    const filePath = join(this.dir, `${id}.md`);
    if (!existsSync(filePath)) {
      throw new Error(`Requirement "${id}" not found`);
    }
    const content = readFileSync(filePath, 'utf-8');
    return this.markdownToDoc(content);
  }

  async list(): Promise<RequirementSummary[]> {
    this.ensureDir();
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.md'));
    const summaries: RequirementSummary[] = [];

    for (const file of files) {
      try {
        const doc = await this.read(file.replace(/\.md$/, ''));
        summaries.push({
          id: doc.id,
          title: doc.title,
          status: doc.status,
          createdAt: doc.createdAt,
        });
      } catch {
        // skip unreadable files
      }
    }

    return summaries.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async exists(id: string): Promise<boolean> {
    return existsSync(join(this.dir, `${id}.md`));
  }
}
