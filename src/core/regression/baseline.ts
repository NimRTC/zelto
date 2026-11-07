// 版本回归基线 —— 「这个版本交付时，哪些用例是绿的」的落盘位置
//
// 定位：跨版本回归基线（G-4 剩余项之一）。
// 版本级验收只给一个「过 / 不过」，看不到「上个版本验证过的东西，
// 这个版本还在不在」。这里把每个版本交付时的用例状态记下来，
// 新版本交付时与上一个已交付版本对比，检出回归。
//
// 落盘位置：`.zelto/regression/<planId>/<version>.json`（C1：状态只在文件里）。
// 按 plan 分目录，是因为版本标签（`v1` / `v2`）在不同计划里会重名 ——
// 混在一起比就会拿错基线。

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TestResult } from './tap.js';

/** 一个版本的回归基线 */
export interface RegressionBaseline {
  /** 格式版本 */
  format: 1;
  /** 所属计划 */
  planId: string;
  /** 版本标签 */
  version: string;
  /** 采集时间 */
  capturedAt: string;
  /** 来源（当前只有版本级验收） */
  source: 'version-acceptance';
  /** 用例状态列表 */
  tests: TestResult[];
}

export class RegressionBaselineStore {
  private readonly root: string;

  constructor(baseDir: string) {
    this.root = join(baseDir, 'regression');
  }

  /** 某个版本基线的文件位置 */
  pathFor(planId: string, version: string): string {
    return join(this.root, planId, `${version}.json`);
  }

  /** 某个版本基线是否存在 */
  exists(planId: string, version: string): boolean {
    return existsSync(this.pathFor(planId, version));
  }

  /** 读某个版本的基线；没有或读坏了都返回 null */
  async read(planId: string, version: string): Promise<RegressionBaseline | null> {
    const filePath = this.pathFor(planId, version);
    if (!existsSync(filePath)) return null;
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content.replace(/^\uFEFF/, '')) as RegressionBaseline;
      if (!parsed || parsed.format !== 1 || !Array.isArray(parsed.tests)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 写基线（临时文件 + rename） */
  async write(baseline: RegressionBaseline): Promise<void> {
    const filePath = this.pathFor(baseline.planId, baseline.version);
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
    await rename(tmp, filePath);
  }
}
