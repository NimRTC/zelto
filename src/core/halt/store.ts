// Halt store —— 「拉闸」请求的文件化存储
//
// 为什么是文件：拉闸是**人**在另一个终端对**正在跑的批次**喊停。
// 批次进程不能常驻（AGENTS.md 禁区：常驻 daemon），所以两边只能通过文件通信：
// 人写一份「停」的请求，正在跑的批次在安全点上读到它并收手。
//
// C1: 状态只在文件里 —— 暂停请求就是 `.zelto/halts/<scope>.json`
// C3: 判定确定 —— 读文件、比对作用域，没有模型参与
// C6: core/ 内，只用 Node 内置

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 一份暂停请求 */
export interface HaltRequest {
  /** 请求 id（时间戳） */
  id: string;
  /** 作用域：'all' 停所有批次；否则是批次键（如 version-v1、batch） */
  scope: string;
  /** 谁喊的停 */
  requestedBy: string;
  /** 原因（人写的，给人自己看的） */
  reason: string;
  /** 时间 */
  requestedAt: string;
}

/**
 * 暂停请求存储。
 *
 * 作用域一个文件：`all` 表示全局暂停；批次键表示只停那一个批次。
 * 人处理完之后 `clear()` 删掉文件，批次才能继续跑下一批。
 */
export class HaltStore {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'halts');
  }

  private path(scope: string): string {
    const safe = scope.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  /** 写一份暂停请求（幂等：同一作用域重复拉闸覆盖旧请求） */
  async request(scope: string, requestedBy: string, reason: string): Promise<HaltRequest> {
    await mkdir(this.dir, { recursive: true });
    const req: HaltRequest = {
      id: `halt-${Date.now()}`,
      scope,
      requestedBy,
      reason,
      requestedAt: new Date().toISOString(),
    };
    await writeFile(this.path(scope), JSON.stringify(req, null, 2), 'utf-8');
    return req;
  }

  /** 读某个作用域的暂停请求；没有就是 null */
  async get(scope: string): Promise<HaltRequest | null> {
    const p = this.path(scope);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(await readFile(p, 'utf-8')) as HaltRequest;
    } catch {
      return null;
    }
  }

  /**
   * 这个批次是否应该停下。
   *
   * 全局暂停（scope='all'）对所有批次生效；批次作用域只对自己生效。
   */
  async isHalted(scope: string): Promise<HaltRequest | null> {
    const global = await this.get('all');
    if (global) return global;
    return this.get(scope);
  }

  /** 解除暂停 */
  async clear(scope: string): Promise<boolean> {
    const p = this.path(scope);
    if (!existsSync(p)) return false;
    await unlink(p);
    return true;
  }

  /**
   * 解除全部暂停请求。
   *
   * 「全部停」之后要恢复，就是全部解 —— 逐个 scope 去解容易漏。
   * 返回被解除的请求列表。
   */
  async clearAll(): Promise<HaltRequest[]> {
    const all = await this.list();
    for (const req of all) {
      await this.clear(req.scope);
    }
    return all;
  }

  /** 列出全部暂停请求 */
  async list(): Promise<HaltRequest[]> {
    try {
      const files = await readdir(this.dir);
      const out: HaltRequest[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          out.push(JSON.parse(await readFile(join(this.dir, file), 'utf-8')) as HaltRequest);
        } catch {
          // 坏文件跳过
        }
      }
      return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    } catch {
      return [];
    }
  }
}
