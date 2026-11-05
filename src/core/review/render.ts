// 草稿的文本渲染 —— 给 diff 用
//
// diff 比的是「人看到的正文」，所以这里把结构化事实渲染成一份稳定文本：
// 同样的事实永远渲染成同样的文本，diff 才有意义（C3）。
//
// 渲染不追求好看，只追求「改了什么一眼能看出来」。

import type {
  DesignFacts,
  DraftFacts,
  DraftKind,
  PlanFacts,
  RequirementFacts,
} from './types.js';

/** 把草稿事实渲染成可 diff 的文本 */
export function renderFacts(kind: DraftKind, facts: DraftFacts): string {
  switch (kind) {
    case 'requirement':
      return renderRequirement(facts as RequirementFacts);
    case 'design':
      return renderDesign(facts as DesignFacts);
    case 'plan':
      return renderPlan(facts as PlanFacts);
  }
}

function renderRequirement(facts: RequirementFacts): string {
  const lines: string[] = [];
  lines.push('# ' + facts.title);
  lines.push('');
  lines.push('## 用户输入');
  lines.push('');
  lines.push(facts.userInput);
  lines.push('');
  lines.push('## 验收标准');
  lines.push('');
  facts.acceptanceCriteria.forEach((c) => lines.push('- ' + c));
  lines.push('');
  lines.push('## 规格正文');
  lines.push('');
  lines.push(facts.spec);
  return lines.join('\n');
}

function renderDesign(facts: DesignFacts): string {
  const lines: string[] = [];
  lines.push('# ' + facts.title);
  lines.push('');
  lines.push('## 模块');
  lines.push('');
  for (const mod of facts.modules) {
    lines.push(`### ${mod.name}`);
    lines.push(mod.description);
    lines.push(`- 负责文件: ${mod.filePatterns.join(', ') || '(无)'}`);
    lines.push(`- 依赖: ${mod.dependencies.join(', ') || '(无)'}`);
    lines.push('');
  }
  lines.push('## 设计正文');
  lines.push('');
  lines.push(facts.body);
  return lines.join('\n');
}

function renderPlan(facts: PlanFacts): string {
  const lines: string[] = [];
  lines.push('# ' + facts.title);
  lines.push('');
  for (const version of facts.versions) {
    lines.push(`## ${version.version} — ${version.description}`);
    lines.push(`- 前置版本: ${version.dependsOn.join(', ') || '(无)'}`);
    lines.push('');
    for (const slice of version.slices) {
      lines.push(`### ${slice.id} — ${slice.title}`);
      lines.push(`- 模块: ${slice.module}`);
      lines.push(`- 写集: ${slice.writes.join(', ') || '(空)'}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
