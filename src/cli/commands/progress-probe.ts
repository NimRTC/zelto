// 进展探针（D-55）——「agent 这一轮还在推进吗」
//
// 病灶（实测于 nimrtc-zelto v3-chrome-waterfall，2026-11-17）：
//
//   适配器的超时原是**绝对超时**（起跑 1800s 一刀切）。而那个 agent 在被砍的
//   前 30 秒**还在改文件** —— 它不是做不完，是「做得完但总时长超过上限」。
//   于是一轮 30 分钟的工作被砍掉、续跑、再砍、再续跑 —— 三轮 90 分钟、
//   token 大把烧掉，产物仍未过门禁。
//
//   绝对超时惩罚的是「做得久」，而超时真正该抓的是「卡住不动」。
//
// 怎么判「在推进」：
//
//   agent 每调用一次工具，PreToolUse 钩子就往**切片自己的事件流**里写一条
//   `policy.decision`。所以「事件流文件变长了」= 「agent 又动了一次」。
//
//   为什么不能只看 stdout：Claude Code 跑的是 `--output-format json`，
//   stdout 直到最后才有内容 —— 一个正在连续调用工具的 agent，
//   在 stdout 看来是「一声不吭」。只看输出会把推进中的 agent 误判成卡住。
//
// C1: 状态只落在文件里（这里只读文件的大小）
// C3: 纯计算，不调模型、不触网

import { statSync } from 'node:fs';
import { join } from 'node:path';

/** 切片事件流文件（相对项目根）。 */
export function sliceEventFile(projectRoot: string, sliceId: string): string {
  return join(projectRoot, '.zelto', 'events', sliceId, 'events.jsonl');
}

/**
 * 进展探针 —— 记住上一次看到的事件流大小，下次比。
 *
 * 用**文件大小**而不是「最后一条事件的时刻」：后者要读整个文件，
 * 而事件流在长跑里可能有几万条 —— 每 5 秒读一遍是白烧 IO。
 * 大小变了就是有新内容，O(1)。
 */
export class SliceProgressProbe {
  private readonly path: string;
  private lastSize: number;
  /** 见过的新事件条数（累计）—— 给调用方一个「推进了多少」的粗粒度指标 */
  private observed = 0;

  constructor(projectRoot: string, sliceId: string) {
    this.path = sliceEventFile(projectRoot, sliceId);
    this.lastSize = this.currentSize();
  }

  private currentSize(): number {
    try {
      return statSync(this.path).size;
    } catch {
      // 文件还不存在（还没起跑）→ 当作 0；下一轮它出现了就是「有进展」。
      return 0;
    }
  }

  /**
   * 探一次。
   *
   * @returns true = 自上次探针以来事件流变长了（agent 又动了）
   */
  poll(): boolean {
    const size = this.currentSize();
    if (size === this.lastSize) return false;
    // 文件被截断（重置）也算有变化 —— 保守地当进展。
    this.lastSize = size;
    this.observed += 1;
    return true;
  }

  /** 自构造以来观察到的新事件批次数。 */
  get observedBatches(): number {
    return this.observed;
  }

  /**
   * 最近一次进展距今多少毫秒。
   *
   * 用**文件 mtime** 而不是事件里的时刻：mtime 是文件系统给的，
   * 不依赖事件内容（事件里的 `ts` 来自另一个进程的时钟，可能偏）。
   */
  idleMs(now: number = Date.now()): number {
    try {
      const st = statSync(this.path);
      return Math.max(0, now - st.mtimeMs);
    } catch {
      return 0;
    }
  }
}
