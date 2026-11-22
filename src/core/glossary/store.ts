// 词汇表的存储 —— 状态只在文件里（C1）
//
// C3: 纯文件读写，不调模型、不触网
// C2: core/ 内，零第三方依赖，不 import adapters/

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GLOSSARY_FILENAME, parseGlossary, renderGlossary } from './glossary.js';
import type { Glossary, GlossaryTerm } from './glossary.js';

/**
 * 词汇表存储。
 *
 * 路径固定 `<zeltoDir>/glossary.json` —— `.zelto/**` 在保护域里（C5），
 * agent 改不了它，词表因此是**人维护的**共享语言，不是 agent 随手改的产物。
 */
export class GlossaryStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** 词表文件路径 */
  get path(): string {
    return join(this.baseDir, GLOSSARY_FILENAME);
  }

  /** 词表是否已建立 */
  async exists(): Promise<boolean> {
    return existsSync(this.path);
  }

  /**
   * 读词表。
   *
   * 没有词表时返回 null —— 「没有词表」与「词表是空的」是两回事，
   * 报告口径必须分开（否则会把「还没建立」说成「一切正常」）。
   */
  async read(): Promise<Glossary | null> {
    if (!existsSync(this.path)) return null;
    try {
      const content = await readFile(this.path, 'utf-8');
      return parseGlossary(content);
    } catch {
      return null;
    }
  }

  /** 写词表（建目录 + 落盘） */
  async write(glossary: Glossary): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.path, renderGlossary(glossary), 'utf-8');
  }

  /**
   * 加一个术语（已存在则更新）。
   *
   * 规范写法相同即视为同一条 —— 更新它的意思与别名，不新增。
   */
  async upsert(term: GlossaryTerm, updatedBy: string): Promise<Glossary> {
    const current = (await this.read()) ?? {
      version: 1,
      updatedAt: '',
      updatedBy: '',
      terms: [],
    };

    const index = current.terms.findIndex((t) => t.term === term.term);
    if (index >= 0) {
      current.terms[index] = term;
    } else {
      current.terms.push(term);
    }
    current.terms.sort((a, b) => a.term.localeCompare(b.term));

    current.version += 1;
    current.updatedAt = new Date().toISOString();
    current.updatedBy = updatedBy;

    await this.write(current);
    return current;
  }

  /** 删一个术语 */
  async remove(term: string, updatedBy: string): Promise<Glossary | null> {
    const current = await this.read();
    if (!current) return null;

    const before = current.terms.length;
    current.terms = current.terms.filter((t) => t.term !== term);
    if (current.terms.length === before) return current;

    current.version += 1;
    current.updatedAt = new Date().toISOString();
    current.updatedBy = updatedBy;

    await this.write(current);
    return current;
  }
}
