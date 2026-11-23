// Event stream — append-only, typed events
// See docs/zelto-技术架构.md §5.3

/**
 * 全部事件类型。
 *
 * 为什么是「一个数组 + 一个派生类型」而不是「一个手写的联合类型」：
 * 事件类型是契约（`contracts/schemas/event-envelope.json` 的 enum 是真源），
 * 这份清单要同时被三处使用 ——
 *
 * 1. `EventType` 联合类型（派生自它，编译期给全链路类型检查）；
 * 2. 审计摘要表 `core/audit/trail.ts`（键类型是 `Record<EventType, ...>`，
 *    少写一种事件就**编译不过**，不必等到运行时才发现审计退化成 `Event: X`）；
 * 3. 契约一致性测试（枚举它，与 schema 的 enum 对账）。
 *
 * 以前它是一个手写的联合类型，于是加事件类型的人只改联合类型，
 * schema 与摘要表就悄悄漂移 —— ADR-036 加的 4 个事件类型从未进过 schema enum，
 * 直到这次补齐才发现「代码能发、契约不认」。
 * 改成数组派生之后，漂移在编译期或测试期就会暴露。
 */
export const EVENT_TYPES = [
  'slice.state.changed',
  'slice.baseline_registered',
  'slice.drift_detected',
  'slice.hotfix',
  'project.policy_migrated',
  'spec.drafted',
  'spec.checked',
  'spec.frozen',
  'clarify.question',
  'clarify.answer',
  'run.started',
  'run.resumed',
  'run.stalled',
  'run.finished',
  'run.aborted',
  'policy.decision',
  'policy.anchor_mismatch',
  'policy.violation',
  'reservation.acquired',
  'reservation.released',
  'gate.executed',
  'gate.result',
  'gate.retry',
  'stall.classified',
  'question.raised',
  'question.answered',
  'budget.spent',
  'llm.called',
  'queue.enqueued',
  'queue.dequeued',
  'sign.requested',
  'sign.approved',
  'sign.rejected',
  'sign.revoked',
  'batch.halted',
  'merge.completed',
  'merge.planned',
  'merge.phase_complete',
  'merge.conflict',
  'merge.stale_base',
  'sched.admitted',
  'sched.blocked',
  'worktree.created',
  'worktree.removed',
  'worktree.base_resolved',
  'coord.dep_added',
  'coord.phase_ready',
  'coord.phase_complete',
  'coord.cycle_detected',
  'artifact.conflict_detected',
  'version.accepted',
  'version.delivered',
  'version.adopted',
  // ADR-073：切片合并后由 merge 同步版本计划状态（in_progress → integrated）
  'version.integrated',
  'draft.created',
  'draft.revised',
  'draft.confirmed',
  'contract.evolution_checked',
  'contract.baseline_updated',
  'version.regression_recorded',
  'version.regression_detected',
  // ADR-057：规格符合性检查（Spec 轴）与词汇表检查
  'spec.conformance_checked',
  'glossary.updated',
  'glossary.usage_checked',
  // ADR-094：人类门三动作（退回重跑 / 退回上游）与 GitHub 追溯链 PR
  'sign.revised',
  'sign.returned',
  'sign.state_mismatch',
  'forge.pr_opened',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope {
  ts: string;
  runSeq: number;
  slice: string;
  run: string | null;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
  /** 前一个已上链事件的 hash；创世事件为 null；老事件缺省（ADR-100）。 */
  prevHash?: string | null;
  /** 本事件的 SHA-256 链哈希；老事件缺省（ADR-100）。新写入必带。 */
  hash?: string;
}

/** 链校验逐行结果（ADR-100 §4）。 */
export interface ChainFailure {
  index: number;
  runSeq: number | null;
  reason: string;
}

export interface ChainVerdict {
  ok: boolean;
  /** 参与哈希校验的事件数（带 hash 的）。 */
  checked: number;
  /** 上链前老事件数（不带 hash 的前缀，直接跳过，不判假）。 */
  unchained: number;
  failures: ChainFailure[];
  /** 链尾 hash（无已上链事件时为 null）。 */
  head: string | null;
}

/**
 * 递归稳定序列化：对象键排序，数组保序。
 *
 * 为什么必须稳定：同一事件在写入时与 verify 时各算一次 hash，
 * `JSON.stringify` 的键序若随插入序漂移，同一内容会算出不同 hash，
 * 链校验必误报。规则固定写死，不随调用方传入序变化（ADR-100 §3）。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 事件上链前的规范内容（ADR-100 §3）。
 *
 * 固定字段序：ts, runSeq, slice, run, type, actor, payload, prevHash。
 * `hash` 自身不参与自哈希 —— 否则成循环定义。
 */
export function canonicalEventContent(e: Omit<EventEnvelope, 'hash'>): string {
  return stableStringify({
    actor: e.actor,
    payload: e.payload,
    prevHash: e.prevHash ?? null,
    run: e.run,
    runSeq: e.runSeq,
    slice: e.slice,
    ts: e.ts,
    type: e.type,
  });
}

async function sha256Hex(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 去掉行首的 BOM（U+FEFF）。
 *
 * Windows 上很常见（PowerShell 5.1 的 `Set-Content -Encoding UTF8`、
 * 记事本、部分编辑器）。仓库里的既有惯例：
 * `core/design/store.ts`、`core/version/branch.ts`、`core/version/store.ts`、
 * `core/contracts/baseline.ts`、`core/regression/baseline.ts`、
 * `core/review/revisions.ts` —— 全是「读时容错、写时不动」。
 *
 * 为什么不能靠 `trim()` 顺手解决：
 * `trim()` 确实会把 U+FEFF 去掉（它属于 JS 的 WhiteSpace），
 * 但 `JSON.parse` **不接受**带 BOM 的字符串 —— 它不是 JSON 语法的一部分。
 * 所以必须显式剥掉，不能指望 trim 顺手带过。
 *
 * 注意：只剥**行首**。BOM 出现在文件开头（第一行）时，
 * 逐行剥就够了；出现在中间的行首则同样是「外部工具追加的痕迹」，一并容错。
 */
function stripBom(line: string): string {
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
}

export class EventStream {
  private readonly baseDir: string;
  private seq: number = 0;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    // Restore last sequence number from existing files to survive restarts
    this.restoreSeq().catch(() => { /* non-fatal */ });
  }

  private async restoreSeq(): Promise<void> {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      let maxSeq = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const eventFile = join(this.baseDir, entry.name, 'events.jsonl');
        try {
          const content = await readFile(eventFile, 'utf-8');
          const trimmed = content.trimEnd();
          const lastNewline = trimmed.lastIndexOf('\n');
          const lastLine = lastNewline >= 0 ? trimmed.slice(lastNewline + 1) : trimmed;
          if (lastLine) {
            // 同样要剥 BOM —— 否则带 BOM 的事件文件读不出 runSeq，
            // 重启后序号会从头开始，与既有事件撞号（C4 的追溯链会乱）
            const last = JSON.parse(stripBom(lastLine));
            if (typeof last.runSeq === 'number' && last.runSeq > maxSeq) {
              maxSeq = last.runSeq;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
      if (maxSeq > 0) {
        this.seq = maxSeq + 1;
      }
    } catch {
      // Directory may not exist yet
    }
  }

  async append(sliceId: string, type: EventType, actor: string, payload: Record<string, unknown>, runId: string | null = null): Promise<EventEnvelope> {
    const { mkdir, appendFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    this.seq++;
    // 链尾 = 同一切片已持久化的最后一个 hash（若文件不存在则为创世）。
    // 读链只读本文件，不跨切片 —— 每片一条链（ADR-100 §2）。
    const prevEvents = await this.read(sliceId);
    let prevHash: string | null = null;
    for (let i = prevEvents.length - 1; i >= 0; i -= 1) {
      if (typeof prevEvents[i].hash === 'string' && prevEvents[i].hash) {
        prevHash = prevEvents[i].hash as string;
        break;
      }
    }
    const base: Omit<EventEnvelope, 'hash'> = {
      ts: new Date().toISOString(),
      runSeq: this.seq,
      slice: sliceId,
      run: runId,
      type,
      actor,
      payload,
      prevHash,
    };
    const hash = await sha256Hex(canonicalEventContent(base));
    const event: EventEnvelope = { ...base, hash };

    const dir = join(this.baseDir, sliceId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf-8');

    return event;
  }

  /**
   * 从持久化存储按写入顺序读回整条链（ADR-100：`loadChain`）。
   * 就是 `read` —— 保留独立命名，给 `audit verify` 一个只读入口语义。
   */
  async loadChain(sliceId: string): Promise<EventEnvelope[]> {
    return this.read(sliceId);
  }

  /**
   * 逐行校验哈希链（ADR-100 §4），只读、不写文件。
   *
   * 规则：
   * - 不带 hash 的老事件前缀直接跳过（`unchained` 计数），不判假；
   * - 第一个带 hash 的事件 prevHash 必须为 null（创世），否则断链；
   * - 每个带 hash 事件：复算 hash 必须一致，且 prevHash 必须等于上一个已上链 hash；
   * - 空 hash / 非法值直接判失败（不允许空串绕过）。
   */
  async verifyChain(sliceId: string): Promise<ChainVerdict> {
    const chain = await this.read(sliceId);
    const failures: ChainFailure[] = [];
    let checked = 0;
    let unchained = 0;
    let lastHash: string | null = null;
    let seenChained = false;

    for (let i = 0; i < chain.length; i += 1) {
      const e = chain[i];
      if (typeof e.hash !== 'string' || !e.hash) {
        // 老事件：还没上链。链开始前跳过；链中间出现视为缺失（断链证据）。
        if (!seenChained) {
          unchained += 1;
          continue;
        }
        failures.push({ index: i, runSeq: typeof e.runSeq === 'number' ? e.runSeq : null, reason: '事件缺失 hash（链中间出现未上链事件）' });
        continue;
      }
      seenChained = true;
      checked += 1;
      const expectedPrev = lastHash;
      const actualPrev = e.prevHash ?? null;
      if (actualPrev !== expectedPrev) {
        failures.push({
          index: i,
          runSeq: typeof e.runSeq === 'number' ? e.runSeq : null,
          reason: `prevHash 对不上：期望 ${expectedPrev ?? 'null'}，实际 ${actualPrev ?? 'null'}`,
        });
        // 断链后仍继续复算，让报告一次说清所有断点。
        lastHash = e.hash;
        continue;
      }
      const { hash, ...rest } = e;
      void hash;
      const recomputed = await sha256Hex(canonicalEventContent(rest as Omit<EventEnvelope, 'hash'>));
      if (recomputed !== e.hash) {
        failures.push({
          index: i,
          runSeq: typeof e.runSeq === 'number' ? e.runSeq : null,
          reason: `hash 对不上：文件记 ${e.hash}，复算 ${recomputed}`,
        });
      }
      lastHash = e.hash;
    }

    return { ok: failures.length === 0, checked, unchained, failures, head: lastHash };
  }

  async read(sliceId: string): Promise<EventEnvelope[]> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    try {
      const content = await readFile(join(this.baseDir, sliceId, 'events.jsonl'), 'utf-8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            // Windows 编辑器可能带 BOM —— 去掉再解析。
            //
            // 为什么这层容错是必须的：事件流是 C4 说的「追溯的唯一证据载体」，
            // 一行读不懂就被静默丢掉，等于**证据凭空消失**。
            // 实测：带 BOM 的 events.jsonl 首行整行解析失败，
            // `gate.result` 事件被丢掉 → 签字页的「验收真跑过」判据误判为不过。
            //
            // 仓库惯例是「读时容错、写时不动」（core/design/store.ts、
            // core/version/branch.ts 等 8 处都是这个写法）：
            // 工具没资格改文件的编码标记。
            return JSON.parse(stripBom(line)) as EventEnvelope;
          } catch {
            return null;
          }
        })
        .filter((e): e is EventEnvelope => e !== null);
    } catch {
      return [];
    }
  }
}
