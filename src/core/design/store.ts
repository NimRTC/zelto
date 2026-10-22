// DesignStore — file-based persistence for design documents
// Stored as JSON in .zelto/design/<id>.json

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DesignDoc, DesignStatus, DesignSummary } from './types.js';

export class DesignStore {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'design');
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  async save(doc: DesignDoc): Promise<void> {
    this.ensureDir();
    const filePath = join(this.dir, `${doc.id}.json`);
    writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf-8');
  }

  async read(id: string): Promise<DesignDoc> {
    const filePath = join(this.dir, `${id}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Design "${id}" not found`);
    }
    return JSON.parse(readFileSync(filePath, 'utf-8')) as DesignDoc;
  }

  async list(): Promise<DesignSummary[]> {
    this.ensureDir();
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const summaries: DesignSummary[] = [];

    for (const file of files) {
      try {
        const doc = await this.read(file.replace(/\.json$/, ''));
        summaries.push({
          id: doc.id,
          title: doc.title,
          requirementId: doc.requirementId,
          status: doc.status,
          moduleCount: doc.modules.length,
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
    return existsSync(join(this.dir, `${id}.json`));
  }
}
