// Write-set reservation — 切片的写集预约
//
// C1: 状态只落在文件里（.zelto/locks/<sliceId>.json），不引入数据库
// C2/C6: 只用 Node 内置模块，不依赖 adapters/
// C3: 纯本地判定，不调模型、不触网
//
// 预约是「切片只允许写自己 writes 内路径」这件事的**运行时凭据**：
// agent 运行期间，hook 读这份预约来判定某次写入是否越界（ADR-014 §3）。
// 没有预约就没有写集约束，因此预约缺失时一律拒绝（fail closed）。

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 预约目录（相对项目根） */
export const LOCKS_DIR = join('.zelto', 'locks');

export interface WriteReservation {
  /** 切片 id */
  sliceId: string;
  /** 该切片允许写入的路径（glob / 目录前缀） */
  writes: string[];
  /** agent 实际工作的目录（worktree 绝对路径）；null 表示在项目根执行 */
  worktree: string | null;
  /** 项目根绝对路径 */
  projectRoot: string;
  /** 预约时刻 */
  acquiredAt: string;
  /** 释放时刻；null 表示仍然有效 */
  releasedAt: string | null;
  /** 持有预约的进程 pid —— 用于识别上次崩溃遗留的僵尸预约 */
  pid: number;
}

export interface AcquireOptions {
  writes: string[];
  worktree?: string | null;
  projectRoot?: string;
  /** 覆盖已存在的预约（重新运行同一切片时） */
  replace?: boolean;
}

export class ReservationStore {
  private readonly baseDir: string;

  constructor(baseDir: string = LOCKS_DIR) {
    this.baseDir = baseDir;
  }

  private pathFor(sliceId: string): string {
    return join(this.baseDir, `${sliceId}.json`);
  }

  /**
   * 取得写集预约。同一切片重复预约会覆盖旧预约（replace 默认 true），
   * 因为同一时刻只能有一个 agent 在跑这个切片。
   */
  async acquire(sliceId: string, options: AcquireOptions): Promise<WriteReservation> {
    const existing = await this.read(sliceId);
    if (existing && !options.replace && !existing.releasedAt) {
      throw new Error(
        `切片 "${sliceId}" 已有生效中的写集预约（pid ${existing.pid}）。` +
        `若确认是上一次运行遗留的，先执行 zelto reservation release ${sliceId}。`,
      );
    }

    const reservation: WriteReservation = {
      sliceId,
      writes: [...options.writes],
      worktree: options.worktree ?? null,
      projectRoot: options.projectRoot ?? process.cwd(),
      acquiredAt: new Date().toISOString(),
      releasedAt: null,
      pid: process.pid,
    };

    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.pathFor(sliceId), JSON.stringify(reservation, null, 2), 'utf-8');
    return reservation;
  }

  /** 释放预约。返回 false 表示该切片本来就没有预约。 */
  async release(sliceId: string): Promise<boolean> {
    const existing = await this.read(sliceId);
    if (!existing) return false;
    existing.releasedAt = new Date().toISOString();
    await writeFile(this.pathFor(sliceId), JSON.stringify(existing, null, 2), 'utf-8');
    return true;
  }

  /** 读取预约；不存在或已损坏时返回 null。 */
  async read(sliceId: string): Promise<WriteReservation | null> {
    if (!existsSync(this.pathFor(sliceId))) return null;
    try {
      const raw = await readFile(this.pathFor(sliceId), 'utf-8');
      const parsed = JSON.parse(raw) as WriteReservation;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.writes)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 列出全部预约（含已释放的）。 */
  async list(): Promise<WriteReservation[]> {
    let names: string[];
    try {
      names = await readdir(this.baseDir);
    } catch {
      return [];
    }
    const results: WriteReservation[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const sliceId = name.replace(/\.json$/, '');
      const reservation = await this.read(sliceId);
      if (reservation) results.push(reservation);
    }
    return results;
  }

  /** 列出仍然生效的预约。 */
  async active(): Promise<WriteReservation[]> {
    return (await this.list()).filter((r) => r.releasedAt === null);
  }
}

/**
 * 判断一个 pid 是否还活着。
 *
 * 用于识别上一次运行崩溃后遗留的僵尸预约 —— 进程没了，预约就不该再约束人。
 * 判定失败（无权限等）时保守地认为进程仍存活。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但当前用户无权发信号
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 清理僵尸预约：预约的持有进程已经不在了，就把释放时间补上。
 * 返回被清理的切片 id 列表。
 */
export async function reapStaleReservations(
  store: ReservationStore,
): Promise<string[]> {
  const reaped: string[] = [];
  for (const reservation of await store.active()) {
    if (reservation.pid === process.pid) continue;
    if (isProcessAlive(reservation.pid)) continue;
    await store.release(reservation.sliceId);
    reaped.push(reservation.sliceId);
  }
  return reaped;
}
