// VersionStore — file-based persistence for version plans
// Stored as JSON in .zelto/versions/<id>.json
//
// ADR-110 决策六：版本计划**双写**到被跟踪的 `versions/<id>.json`。
//
// 为什么：`.zelto/` 整体在 .gitignore 里（实测 `git ls-files .zelto` → 0 个文件），
// 于是「哪个计划的哪一版对应哪个 tag」这个信息**只有本机知道** ——
// CI 读不到，而追溯链恰恰要求它可查（ADR-110 缺陷四）。
//
// 为什么不把版本计划整个移出 `.zelto/`：`.zelto/` 里有大量运行时状态
// （切片状态、事件、锁），整个移出会破坏目录约定与现有工具路径。
// 只把**版本计划**这一类规格产物复制出来，是最小改动。
//
// 读**只**从 `.zelto/` 读（那是运行时真源）；写**同时**写两份。
// 两份不做双向同步 —— 那会让「谁是权威」变成一个新问题。

import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteText } from '../io/atomic-write.js';
import type { VersionPlan, VersionStatus, VersionSummary } from './types.js';

/** 被跟踪的版本计划副本目录（相对仓库根）—— ADR-110 决策六。 */
export const TRACKED_VERSIONS_DIR = 'versions';

export class VersionStore {
  private readonly dir: string;
  /** 跟踪副本目录的绝对路径（从运行时目录的上一级推出来：`<base>/versions` → `<base>/../versions`） */
  private readonly trackedDir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'versions');
    // baseDir 通常是 `<repo>/.zelto` —— 跟踪副本在 `<repo>/versions`。
    this.trackedDir = join(baseDir, '..', TRACKED_VERSIONS_DIR);
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** 计划文件的路径（ADR-082：调用方需要可核对的写入凭据） */
  pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** 跟踪副本的路径（ADR-110 决策六） */
  trackedPathFor(id: string): string {
    return join(this.trackedDir, `${id}.json`);
  }

  async save(plan: VersionPlan): Promise<void> {
    this.ensureDir();
    const filePath = this.pathFor(plan.id);
    const content = JSON.stringify(plan, null, 2);
    // ADR-082：原子写入 + 写完读回验证；失败必抛，不静默。
    await atomicWriteText(filePath, content);

    // ADR-110 决策六：同步写跟踪副本。
    //
    // 为什么副本写失败**不抛**：副本是**派生**的（真源已落盘），
    // 抛出去会让「保存计划」这个动作因为一个派生文件失败 ——
    // 而真源已经写好了，抛异常反而让人以为计划没存上。
    // 但也**不能静默** —— 记一条 stderr 警告，让人看得见。
    try {
      if (!existsSync(this.trackedDir)) {
        mkdirSync(this.trackedDir, { recursive: true });
      }
      await atomicWriteText(this.trackedPathFor(plan.id), content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[version-store] 警告：版本计划的跟踪副本写入失败（${this.trackedPathFor(plan.id)}）：${msg}\n` +
          `            运行时真源已写好，但副本缺失 —— CI 将读不到这个计划。\n`,
      );
    }
  }

  async read(id: string): Promise<VersionPlan> {
    const filePath = join(this.dir, `${id}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Version plan "${id}" not found`);
    }
    const content = readFileSync(filePath, 'utf-8');
    // Windows 编辑器可能带 BOM —— 去掉再解析
    return JSON.parse(content.replace(/^\uFEFF/, '')) as VersionPlan;
  }

  async list(): Promise<VersionSummary[]> {
    this.ensureDir();
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const summaries: VersionSummary[] = [];

    for (const file of files) {
      try {
        const plan = await this.read(file.replace(/\.json$/, ''));
        summaries.push({
          id: plan.id,
          title: plan.title,
          versionCount: plan.versions.length,
          status: plan.status,
          createdAt: plan.createdAt,
        });
      } catch {
        // skip unreadable files
      }
    }

    return summaries.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async updateVersionStatus(
    planId: string,
    version: string,
    status: VersionStatus,
  ): Promise<VersionPlan> {
    const plan = await this.read(planId);
    const v = plan.versions.find((v) => v.version === version);
    if (!v) throw new Error(`Version "${version}" not found in plan "${planId}"`);
    v.status = status;
    await this.save(plan);
    return plan;
  }

  async exists(id: string): Promise<boolean> {
    return existsSync(join(this.dir, `${id}.json`));
  }
}
