// 默认设计的选取规则 —— arch check 与架构护栏共用同一口径
//
// C3: 纯函数，不碰文件、不调模型、不触网
// C6: core/ 内，不依赖 adapters/
//
// 为什么需要这一层：
//
// `DesignStore.list()` 按创建时间倒序返回，于是「取第一份 confirmed」
// 拿到的是**最新创建**的设计。可最新创建的设计往往是某个局部功能的
// 设计（如「Policy 命令行工具技术设计」，6 个模块），而不是描述整个
// 仓库结构的基线设计。
//
// 后果是实打实的，不只是报告难看：
//   - `zelto arch check` 自检时拿局部设计对照全仓，306 个文件全被判
//     「无归属」，结论完全误导；
//   - 门禁护栏用的是同一份设计，于是本该正常的写集（哪怕只改
//     `src/core/policy/engine.ts`）被判 `unmapped_file` 而 **blocked**。
//
// 选取规则（有优先级，逐级退化）：
//
// 1. **项目基线设计**（`requirementId === '__project__'`）——
//    由 `zelto project design` 生成，模块覆盖整个仓库，是「拿设计与
//    仓库对照」这件事唯一说得通的对象。同级有多份时取最新。
// 2. **最新的已确认设计** —— 没有基线设计时的退化选择，
//    保持旧行为（有基线时行为改变，这是本次修正的目的）。
//
// 3. 无已确认设计 → 返回 null，调用方按「无设计可对照」处理
//    （`arch check` 报错退出，护栏路径跳过）。
//
// 显式指定（`--design <id>`）永远优先于此规则。

import type { DesignSummary } from './types.js';

/** 项目基线设计的 requirementId（`zelto project design` 生成的标记） */
export const PROJECT_REQUIREMENT_ID = '__project__';

/**
 * 选出用于架构对照的默认设计。
 *
 * @param designs 全部设计的摘要（不必预先过滤状态）
 * @returns 默认设计；没有已确认设计时返回 null
 */
export function pickDefaultDesign(designs: DesignSummary[]): DesignSummary | null {
  const confirmed = designs.filter((d) => d.status === 'confirmed');
  if (confirmed.length === 0) return null;

  // list() 已按 createdAt 倒序；这里再排一次，让本函数不依赖调用方的顺序
  const byNewest = [...confirmed].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const baseline = byNewest.find((d) => d.requirementId === PROJECT_REQUIREMENT_ID);
  return baseline ?? byNewest[0];
}

/**
 * 列出「被跳过的其它已确认设计」，供 CLI 提示 `--design` 怎么用。
 *
 * @param designs 全部设计的摘要
 * @param pickedId 已选中的设计 id（不在返回列表里）；为空时返回空列表
 */
export function otherConfirmedDesigns(
  designs: DesignSummary[],
  pickedId: string | null,
): DesignSummary[] {
  if (!pickedId) return [];
  return designs.filter((d) => d.status === 'confirmed' && d.id !== pickedId);
}