// 契约基线 —— 「上一版契约长什么样」的落盘位置
//
// 为什么需要它：`contracts/schemas/` 里的文件一直在改，改完之后**旧版数据**
// 是否还能被新版接受，只看当前文件是看不出来的。必须有个人工确认过的
// 基线快照，才能算出「这次改动破坏了哪些兼容性」。
//
// 基线是什么：一份「人确认过的契约集合」——契约名 → schema 原文。
// 更新基线 = 人签字接受这次变化（ADR-036）。所以写入基线是一个**显式命令**，
// 不是自动动作：自动化会把「破坏」也一起签掉，那道闸门就没意义了。
//
// 落盘位置：`.zelto/contracts/baseline.json`（C1：状态只在文件里）。
// 写文件用「临时文件 + rename」，避免写到一半崩了留下半个 JSON。

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 一份契约基线 */
export interface ContractBaseline {
  /** 格式版本 —— 以后改结构时靠它区分 */
  format: 1;
  /** 基线确认时间 */
  updatedAt: string;
  /** 谁确认的（人名 / 来源说明） */
  updatedBy: string;
  /** 契约名 → schema 原文 */
  contracts: Record<string, Record<string, unknown>>;
}

export class ContractBaselineStore {
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = join(baseDir, 'contracts', 'baseline.json');
  }

  /** 基线文件的位置（给人看的路径） */
  get path(): string {
    return this.filePath;
  }

  /** 基线是否存在 */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /**
   * 读基线。没有基线时返回 null —— 「没有基线」与「基线是空的」是两件事，
   * 前者是「还没确认过」，后者是「确认过没有契约」，报告时要分开说。
   */
  async read(): Promise<ContractBaseline | null> {
    if (!existsSync(this.filePath)) return null;
    try {
      const content = await readFile(this.filePath, 'utf-8');
      // Windows 编辑器可能带 BOM —— 去掉再解析
      const parsed = JSON.parse(content.replace(/^\uFEFF/, '')) as ContractBaseline;
      if (!parsed || parsed.format !== 1 || typeof parsed.contracts !== 'object') return null;
      return parsed;
    } catch {
      // 读坏了的基线按「没有基线」处理 —— 但不静默覆盖它，
      // 要写新基线时人得显式跑 baseline 命令。
      return null;
    }
  }

  /** 写基线（临时文件 + rename，避免半截文件） */
  async write(baseline: ContractBaseline): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
    await rename(tmp, this.filePath);
  }
}
