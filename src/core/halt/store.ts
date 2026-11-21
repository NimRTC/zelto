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
  /**
   * 这份请求什么时候**过期**（ISO 时间）。
   *
   * `null` = 永不过期（人显式要的）。
   *
   * 过期只影响「拦不拦新工作」，**不影响「停不停在跑的活」** ——
   * 人喊停是为了让现在跑的停下来；那份请求两小时后过期了，
   * 正在跑的 agent 也还是得停。
   *
   * 为什么要有它（ZD-023）：踩下刹车之后没人松，刹车就一直咬着。
   * 一份陈旧的全局暂停请求会**挡住后面所有切片** ——
   * 而「这块地方我一会儿再处理」本来就是临时状态。
   */
  expiresAt: string | null;
}

/**
 * 默认有效期：30 分钟。
 *
 * 为什么是 30 分钟：拉闸是「我现在要接管现场」—— 接管通常是分钟级的
 * （看一眼、改个文件、决定重跑还是放弃）。30 分钟足够覆盖一次接管，
 * 又不至于让一次遗忘把后面大半个工作日都堵死。
 */
export const DEFAULT_HALT_TTL_MS = 30 * 60 * 1000;

/**
 * 暂停请求存储。
 *
 * 作用域一个文件：`all` 表示全局暂停；批次键表示只停那一个批次。
 * 人处理完之后 `clear()` 删掉文件，批次才能继续跑下一批。
 */
export class HaltStore {
  private readonly dir: string;
  /** 有效期（毫秒）；<= 0 表示永不过期 */
  private readonly defaultTtlMs: number;

  /**
   * @param baseDir `.zelto` 目录（store 自己再拼 `halts/`）
   * @param defaultTtlMs 默认有效期；<= 0 = 永不过期
   */
  constructor(baseDir: string, defaultTtlMs: number = DEFAULT_HALT_TTL_MS) {
    this.dir = join(baseDir, 'halts');
    this.defaultTtlMs = defaultTtlMs;
  }

  private path(scope: string): string {
    const safe = scope.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  /**
   * 写一份暂停请求（幂等：同一作用域重复拉闸覆盖旧请求）。
   *
   * @param ttlMs 有效期；<= 0 = 永不过期（默认用构造时的 `defaultTtlMs`）
   */
  async request(
    scope: string,
    requestedBy: string,
    reason: string,
    ttlMs?: number,
  ): Promise<HaltRequest> {
    await mkdir(this.dir, { recursive: true });
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    const req: HaltRequest = {
      id: `halt-${Date.now()}`,
      scope,
      requestedBy,
      reason,
      requestedAt: new Date().toISOString(),
      expiresAt:
        effectiveTtl > 0
          ? new Date(Date.now() + effectiveTtl).toISOString()
          : null,
    };
    await writeFile(this.path(scope), JSON.stringify(req, null, 2), 'utf-8');
    return req;
  }

  /** 读某个作用域的暂停请求；没有就是 null */
  async get(scope: string): Promise<HaltRequest | null> {
    const p = this.path(scope);
    if (!existsSync(p)) return null;
    try {
      const raw = JSON.parse(await readFile(p, 'utf-8')) as HaltRequest;
      return this.normalize(raw);
    } catch {
      return null;
    }
  }

  /**
   * 补齐**旧格式**请求里缺失的 `expiresAt`。
   *
   * 为什么需要：TTL 是后加的，之前写的请求文件里根本没有这个字段。
   * 如果把它们当成「永不过期」，那 ZD-023 里那份真实的陈旧请求
   * 就**永远**堵着后面的切片 —— 修了等于没修。
   *
   * 区分两种「没有 expiresAt」：
   * - `undefined`（字段根本不存在）→ 旧文件 → 按 `requestedAt + 默认TTL` 回填；
   * - `null`（字段存在，明确表示永不过期）→ 新写的显式意图 → 尊重它。
   */
  private normalize(req: HaltRequest): HaltRequest {
    if (req.expiresAt !== undefined) return req;
    if (this.defaultTtlMs <= 0) return { ...req, expiresAt: null };
    const at = Date.parse(req.requestedAt);
    // 时间戳坏掉 → 回填成「从现在起算」：宁可多拦一次，
    // 也不因为一条坏数据就把它当成永不过期。
    const base = Number.isNaN(at) ? Date.now() : at;
    return {
      ...req,
      expiresAt: new Date(base + this.defaultTtlMs).toISOString(),
    };
  }

  /**
   * 这份请求是否已经过期。
   *
   * **过期只影响「拦不拦新工作」** —— 见 `HaltRequest.expiresAt` 的说明。
   * 判定：没有 `expiresAt` = 永不过期；否则比 `now`。
   */
  isExpired(req: HaltRequest, now: number = Date.now()): boolean {
    const effective = this.normalize(req);
    if (!effective.expiresAt) return false;
    const at = Date.parse(effective.expiresAt);
    // 时间戳坏掉 → 当作**没过期**（fail closed：宁可多拦一次，
    // 也不因为一条坏数据就把人的刹车当成没踩）
    if (Number.isNaN(at)) return false;
    return now >= at;
  }

  /**
   * 这个批次是否应该停下。
   *
   * 全局暂停（scope='all'）对所有批次生效；批次作用域只对自己生效。
   *
   * **不管过期** —— 人喊停是为了让现在跑的停下来；
   * 那份请求两小时后过期了，正在跑的 agent 也还是得停。
   * 过期只作用于「要不要开始新工作」（见 `isBlockingNewWork`）。
   */
  async isHalted(scope: string): Promise<HaltRequest | null> {
    const global = await this.get('all');
    if (global) return global;
    return this.get(scope);
  }

  /**
   * 这份暂停请求是否应当**拦住新工作**（起跑新切片 / 开新 agent）。
   *
   * 与 `isHalted` 的区别就是**过期**：
   * - `isHalted` → 「在跑的活要不要停」—— 永远看有没有请求；
   * - `isBlockingNewWork` → 「新的活要不要开始」—— 看请求是否还有效。
   *
   * 没有请求 → null（不拦）。
   * 有请求但已过期 → null（不拦，但请求仍在磁盘上，随时可被人 `--clear`）。
   */
  async isBlockingNewWork(
    scope: string,
    now: number = Date.now(),
  ): Promise<HaltRequest | null> {
    const req = await this.isHalted(scope);
    if (!req) return null;
    return this.isExpired(req, now) ? null : req;
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
          const raw = JSON.parse(await readFile(join(this.dir, file), 'utf-8')) as HaltRequest;
          out.push(this.normalize(raw));
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
