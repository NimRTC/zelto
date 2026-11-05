// 修订快照 —— 让「diff」有得可对
//
// refine 是「就地覆盖」：旧稿被新稿顶掉，就没有 diff 可看了。
// 所以每次覆盖之前，先把旧稿快照一份，留在 `.zelto/revisions/<kind>/<id>/`。
//
// C1: 状态只在文件里——快照是文件，不在内存里攒着
// C4: 快照是 append-only 的——只增不改，删了就是删了证据

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DraftKind } from './types.js';

export interface RevisionMeta {
  /** 文件名（同时是排序键） */
  id: string;
  kind: DraftKind;
  docId: string;
  createdAt: string;
}

interface RevisionFile extends RevisionMeta {
  payload: unknown;
}

export class RevisionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = join(baseDir, 'revisions');
  }

  private docDir(kind: DraftKind, docId: string): string {
    return join(this.baseDir, kind, docId);
  }

  /**
   * 存一份快照。
   *
   * 文件名用时间戳，同一毫秒内多次快照靠计数器区分，不覆盖已有快照。
   */
  async snapshot(kind: DraftKind, docId: string, payload: unknown): Promise<RevisionMeta> {
    const dir = this.docDir(kind, docId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const base = new Date().toISOString().replace(/[:.]/g, '-');
    let id = base;
    let counter = 1;
    while (existsSync(join(dir, `${id}.json`))) {
      id = `${base}-${counter}`;
      counter++;
    }

    const meta: RevisionMeta = {
      id,
      kind,
      docId,
      createdAt: new Date().toISOString(),
    };
    const file: RevisionFile = { ...meta, payload };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(file, null, 2), 'utf-8');
    return meta;
  }

  /** 列出某份草稿的全部快照（按时间正序） */
  async list(kind: DraftKind, docId: string): Promise<RevisionMeta[]> {
    const dir = this.docDir(kind, docId);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const metas: RevisionMeta[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        // Windows 编辑器可能带 BOM —— 去掉再解析
        const parsed = JSON.parse(content.replace(/^\uFEFF/, '')) as RevisionFile;
        metas.push({
          id: parsed.id ?? file.replace(/\.json$/, ''),
          kind: parsed.kind ?? kind,
          docId: parsed.docId ?? docId,
          createdAt: parsed.createdAt ?? '',
        });
      } catch {
        // 跳过读不懂的快照，不让一份坏文件挡住整条命令
      }
    }
    return metas.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 取最近一份快照的载荷 */
  async latestPayload(kind: DraftKind, docId: string): Promise<unknown | null> {
    const metas = await this.list(kind, docId);
    if (metas.length === 0) return null;
    const last = metas[metas.length - 1];
    const path = join(this.docDir(kind, docId), `${last.id}.json`);
    try {
      const content = readFileSync(path, 'utf-8');
      const file = JSON.parse(content.replace(/^\uFEFF/, '')) as RevisionFile;
      return file.payload;
    } catch {
      return null;
    }
  }
}
