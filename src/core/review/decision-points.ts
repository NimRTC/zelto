// 决策点抽取 —— 「只看决策点」
//
// 人确认一份规划时，真正需要拍板的东西是有限的：
// 验收标准、模块划分、模块之间的依赖、版本切分。
// 其余正文是「为什么要这么定」的说明，通读它只是浪费时间。
//
// 这里的抽取全是**确定性**的：按结构解析，不调模型、不猜语义（C3、C7）。
// 抽取规则写死在下面，谁都能看懂它为什么这么抽。

import type {
  DecisionPoint,
  DesignFacts,
  PlanFacts,
  RequirementFacts,
} from './types.js';

const HEADING_REGEX = /^#{1,6}\s+(.+?)\s*$/;

/**
 * 需求草稿的决策点：
 * - 每条验收标准一个点（验收标准就是要拍板的东西）
 * - 规格里的每个标题一个点（结构是拍板的东西，正文不是）
 */
export function requirementDecisionPoints(facts: RequirementFacts): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  facts.acceptanceCriteria.forEach((criterion, idx) => {
    points.push({
      id: `ac-${idx + 1}`,
      kind: 'acceptance',
      label: criterion,
      detail: '',
      status: 'unchanged',
    });
  });

  const headingSeen = new Map<string, number>();
  for (const line of facts.spec.split('\n')) {
    const match = line.match(HEADING_REGEX);
    if (!match) continue;
    const title = match[1];
    const count = (headingSeen.get(title) ?? 0) + 1;
    headingSeen.set(title, count);
    // 同名标题按出现次序编号，保证 id 稳定唯一
    points.push({
      id: `sec-${slug(title)}-${count}`,
      kind: 'section',
      label: title,
      detail: '',
      status: 'unchanged',
    });
  }

  return points;
}

/**
 * 设计草稿的决策点：
 * - 每个模块一个点（模块划分是拍板的东西）
 * - 每条模块依赖边一个点（依赖方向错了，后面全白干）
 */
export function designDecisionPoints(facts: DesignFacts): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const mod of facts.modules) {
    points.push({
      id: `mod-${slug(mod.name)}`,
      kind: 'module',
      label: mod.name,
      detail: mod.description,
      status: 'unchanged',
    });
    for (const dep of mod.dependencies) {
      points.push({
        id: `dep-${slug(mod.name)}-${slug(dep)}`,
        kind: 'dependency',
        label: `${mod.name} → ${dep}`,
        detail: '',
        status: 'unchanged',
      });
    }
  }

  return points;
}

/**
 * 版本计划的决策点：
 * - 每个版本一个点（版本切分是拍板的东西）
 * - 每个切片一个点（写集是并行能不能开的依据）
 */
export function planDecisionPoints(facts: PlanFacts): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const version of facts.versions) {
    points.push({
      id: `ver-${slug(version.version)}`,
      kind: 'version',
      label: `${version.version} — ${version.description}`,
      detail: version.dependsOn.length > 0 ? `depends on: ${version.dependsOn.join(', ')}` : '',
      status: 'unchanged',
    });
    for (const slice of version.slices) {
      points.push({
        id: `slice-${slug(slice.id)}`,
        kind: 'slice',
        label: `${slice.id} — ${slice.title}`,
        detail: slice.writes.length > 0 ? `writes: ${slice.writes.join(', ')}` : '',
        status: 'unchanged',
    });
    }
  }

  return points;
}

/** 把标题压成可放进 id 的短标识 */
function slug(text: string): string {
  const lowered = text.trim().toLowerCase();
  const ascii = lowered.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii.length > 0 ? ascii : 'x';
}
