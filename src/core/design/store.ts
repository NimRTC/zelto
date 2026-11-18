// DesignStore — file-based persistence for design documents
// Stored as JSON in .zelto/design/<id>.json

import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteText } from '../io/atomic-write.js';
import { deriveModules } from './derive.js';
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

  /** 设计文件的路径（ADR-082：调用方需要可核对的写入凭据） */
  pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async save(doc: DesignDoc): Promise<void> {
    this.ensureDir();
    const filePath = this.pathFor(doc.id);
    // ADR-082：原子写入 + 写完读回验证；失败必抛，不静默。
    await atomicWriteText(filePath, JSON.stringify(doc, null, 2));
  }

  async read(id: string): Promise<DesignDoc> {
    const filePath = join(this.dir, `${id}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Design "${id}" not found`);
    }
    const content = readFileSync(filePath, 'utf-8');
    // Windows 编辑器可能带 BOM —— 去掉再解析
    return JSON.parse(content.replace(/^\uFEFF/, '')) as DesignDoc;
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
          // 模块数从正文推导（正文是真源），存的 modules 只是缓存
          moduleCount: deriveModules(doc).length,
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
