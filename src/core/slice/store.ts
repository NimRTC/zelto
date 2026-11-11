// Slice persistence — read/write .zelto/slices/<id>.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { type SliceState, transitionSlice, isTerminalState, type SliceEvent } from './state.js';
import type { StallInfo } from '../stall/types.js';
import type { SliceType } from './kind.js';

export interface SliceSpec {
  path: string;
  frozenHash: string | null;
  frozenAt: string | null;
  /**
   * 本片**专属**的门禁命令（ADR-051）。
   *
   * 为什么需要：项目级 `gate.commands` 只能有一套 —— 在 nimrtc 上它指向
   * `net_feedback` 模块的测试目标。但不同模块的测试目标名字不同
   * （`test_net_feedback_test` vs `test_bwe_feedback_fields_test`），
   * 门禁去构建**别的模块**的目标，既不验本片的产物，又白等一次构建。
   *
   * 本片的门禁命令由**人**写在这里 —— 它是「这片怎么算验过了」的口径，
   * 不该由工具从写集路径猜（猜出来的名字多半不对）。
   *
   * 缺省 = 用项目级命令（`gate.commands` 或对应 profile）。
   */
  gateCommands?: Array<{ name: string; run: string; timeoutSec?: number }>;
}

export interface SliceAcceptance {
  dir: string;
  frozenHash: string | null;
  oracleSrc: 'external' | 'human' | 'model-transcribed' | null;
}

export interface SliceDrift {
  detected: boolean;
  reason: string | null;
  at: string | null;
}

export interface SliceTrace {
  requirements: string[];
  contracts: string[];
  tests: string[];
}

/**
 * 一次 agent 运行的记录（ADR-041 §3.1）。
 *
 * 「一次运行」的边界：**agent 进程结束** —— 无论成功、失败、被提问挂起还是越界回退。
 * 门禁、签字、合并都不算运行 —— 它们不是 agent 的执行。
 *
 * `ok` 记的是 agent 进程自己的退出结果：退出码 0 为 true。
 * 越界（写集违规）不会翻转这个标志 —— 那是另一次判定的事实，
 * 记在 `run.aborted` 事件里，不在运行记录里重复表达。
 */
export interface SliceRun {
  /** 运行结束的时刻（ISO 8601） */
  at: string;
  /** agent 进程是否正常退出（退出码 0） */
  ok: boolean;
  /** agent 退出码；被信号打断时为 null */
  exitCode: number | null;
}

export interface SliceData {
  id: string;
  title: string;
  state: SliceState;
  spec: SliceSpec;
  acceptance: SliceAcceptance;
  baseCommit: string | null;
  drift: SliceDrift;
  trace: SliceTrace;
  traceWaiver: string | null;
  baseline: boolean;
  type?: SliceType;
  writes: string[];
  /** 运行记录 —— 每次 agent 运行结束追加一条（ADR-041 §3.1） */
  runs: SliceRun[];
  /** 已经走过的澄清轮次（澄清问题 ID 里带轮次号，必须单调递增） */
  clarifyRounds?: number;
  stall: StallInfo;
  agentTimeout?: number;
  createdAt: string;
  updatedAt: string;
}

export type SliceEventRecord = {
  event: SliceEvent;
  from: SliceState;
  to: SliceState;
  at: string;
  by: string;
};

/**
 * 把 `runs` 归一化成运行记录数组。
 *
 * 老状态文件里 `runs` 是 `string[]` 且从未被写入过（永远是 `[]`），
 * 所以这里不需要做「字符串 → 对象」的迁移：真出现脏数据就丢掉，
 * 宁可少一条也不伪造一条（伪造的 `at` / `ok` 会污染澄清轮次之外的判断）。
 */
function normalizeRuns(raw: unknown): SliceRun[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is SliceRun =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as SliceRun).at === 'string' &&
      typeof (r as SliceRun).ok === 'boolean',
  );
}

export class SliceStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private path(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }

  async read(id: string): Promise<SliceData> {
    const content = await readFile(this.path(id), 'utf-8');
    const slice = JSON.parse(content) as SliceData;
    // 归一化：老状态文件里 `runs` 从未被写入过（永远是空数组），
    // `clarifyRounds` 也不存在。读的时候补齐，避免各处散着做兜底。
    slice.runs = normalizeRuns(slice.runs);
    if (typeof slice.clarifyRounds !== 'number' || !Number.isFinite(slice.clarifyRounds)) {
      slice.clarifyRounds = 0;
    }
    // 终态自愈（ADR-041 §3.3）：已经 completed / abandoned 的切片不该还挂着停机分类。
    // 老状态文件是在清账规则落地之前写的 —— 读的时候顺手归正，
    // 免得人看状态得出「它还卡着」的错误结论。
    // 写失败（只读目录等）不阻断读：返回值本身已经是正的。
    if (isTerminalState(slice.state) && slice.stall.class !== null) {
      slice.stall.class = null;
      try {
        await this.write(slice);
      } catch {
        // 写不了就算了 —— 内存里的值已经是正确的
      }
    }
    return slice;
  }

  async write(slice: SliceData): Promise<void> {
    const p = this.path(slice.id);
    await mkdir(dirname(p), { recursive: true });
    slice.updatedAt = new Date().toISOString();
    await writeFile(p, JSON.stringify(slice, null, 2), 'utf-8');
  }

  async exists(id: string): Promise<boolean> {
    return existsSync(this.path(id));
  }

  async list(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(this.baseDir).catch(() => []);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  }

  async transit(id: string, event: SliceEvent, by: string = 'system'): Promise<SliceData> {
    const slice = await this.read(id);
    const from = slice.state;
    const to = transitionSlice(from, event);
    slice.state = to;
    // 终态清停机分类（ADR-041 §3.3）：停机的语义是「这片现在卡住了，需要人介入」。
    // 一片已经 completed / abandoned 的切片带着停机分类，人看状态会得出错误结论。
    if (isTerminalState(to) && slice.stall.class !== null) {
      slice.stall.class = null;
    }
    slice.updatedAt = new Date().toISOString();
    await this.write(slice);
    return slice;
  }

  /**
   * 记一次运行（ADR-041 §3.1）。
   *
   * 「一次运行」= agent 进程跑完一次。调用点都在 agent 退出之后：
   * 成功、失败、被提问挂起、越界回退 —— 都算一次。
   *
   * 为什么要有它：事件流记的是「发生过什么」，切片状态记的是「这片现在什么样」。
   * `runs` 之前是死字段（永远空数组），人查切片状态得到的是假信息；
   * 澄清轮次也因为读它而永远停在第 1 轮。
   */
  async recordRun(id: string, run: { ok: boolean; exitCode: number | null; at?: string }): Promise<void> {
    const slice = await this.read(id);
    slice.runs.push({
      at: run.at ?? new Date().toISOString(),
      ok: run.ok,
      exitCode: run.exitCode ?? null,
    });
    await this.write(slice);
  }

  /**
   * 澄清轮次 +1，返回这一轮是第几轮（从 1 开始）。
   *
   * 轮次号会进澄清问题 ID（`<slice>-<category>-<round>`）——
   * 轮次不单调递增，两轮澄清会撞 ID。
   */
  async nextClarifyRound(id: string): Promise<number> {
    const slice = await this.read(id);
    slice.clarifyRounds = (slice.clarifyRounds ?? 0) + 1;
    await this.write(slice);
    return slice.clarifyRounds;
  }

  create(
    id: string,
    title: string,
    opts?: Partial<Omit<SliceData, 'id' | 'title' | 'state' | 'createdAt' | 'updatedAt'>>,
  ): SliceData {
    const now = new Date().toISOString();
    return {
      id,
      title,
      state: 'draft',
      spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
      acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
      baseCommit: opts?.baseCommit ?? null,
      drift: { detected: false, reason: null, at: null },
      trace: opts?.trace ?? { requirements: [], contracts: [], tests: [] },
      traceWaiver: opts?.traceWaiver ?? null,
      baseline: opts?.baseline ?? false,
      type: opts?.type,
      writes: opts?.writes ?? [],
      runs: opts?.runs ?? [],
      clarifyRounds: opts?.clarifyRounds ?? 0,
      stall: opts?.stall ?? { class: null, autoResolved: 0, gateRetries: 0 },
      agentTimeout: opts?.agentTimeout,
      createdAt: now,
      updatedAt: now,
    };
  }
}
