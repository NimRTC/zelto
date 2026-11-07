// 规格文档的章节契约 —— 「这份规格写全了没有」的唯一依据。
//
// C3: 静态表 + 字符串解析，确定性，不调模型、不触网。
//
// 章节按「概念 + 别名」描述：同一个概念可以用英文标题或中文标题，
// 命中任一别名即视为存在。这与 core/spec/scope.ts 的既有做法一致
// （那里也是 `/范围|scope|range/i` 这样中英文一起认）。
//
// 必备章节只取两个：**Summary** 与 **Acceptance Criteria**。
// 取这两个是因为它们在仓库里所有三种规格写法里都出现：
//   - zelto 自己生成的模板（cli/commands/shared.ts 的 generateSliceSpecContent）→ 目的 / 验收标准
//   - 从既有规格创建切片的模板（cli/commands/core-slice.ts）→ Summary / Acceptance Criteria
//   - specs/slices/ 下现存的 70+ 份规格 → 目的 / 验收标准
// 其余章节（范围 / 设计 / 风险 / 测试策略）都是建议项——它们在本仓库
// 的规格里时有时无，当成必备只会让每一份规格都报缺章节，那是噪声不是信号。
//
// 语义分析器（core/spec/semantic/analyzer.ts）里的「设计」「测试策略」检查
// 也走这里的别名表，理由相同。

/** 一个规格章节的定义 */
export interface SectionSpec {
  /** 概念名——报告里用它指代这一节 */
  concept: string;
  /** 可接受的标题（不含 `##` 前缀） */
  aliases: string[];
  /** 是否为必备章节 */
  required: boolean;
}

/** 规格章节表 */
export const SPEC_SECTIONS: SectionSpec[] = [
  { concept: 'Summary', aliases: ['Summary', 'Purpose', '目的'], required: true },
  { concept: 'Acceptance Criteria', aliases: ['Acceptance Criteria', 'Acceptance', '验收标准'], required: true },
  // 「需求」章节是追溯引用的另一种出处写法：有些规格先列需求再列验收标准。
  // 非必备——缺它只是拿不到这路出处，不构成规格缺陷（ADR-032 §3.3）。
  { concept: 'Requirements', aliases: ['Requirements', 'Requirement', '需求'], required: false },
  { concept: 'Scope', aliases: ['Scope', 'Range', '范围'], required: false },
  { concept: 'Design', aliases: ['Design', '设计'], required: false },
  { concept: 'API / Interface Changes', aliases: ['API / Interface Changes', 'API Changes', 'API', '接口变更'], required: false },
  { concept: 'Risk', aliases: ['Risk', 'Risks', '风险'], required: false },
  { concept: 'Testing Strategy', aliases: ['Testing Strategy', 'Testing', '测试策略', '测试计划'], required: false },
];

/** 必备章节的概念名 */
export const REQUIRED_SECTIONS: string[] = SPEC_SECTIONS
  .filter((s) => s.required)
  .map((s) => s.concept);

/** 按概念名取章节定义 */
export function sectionByConcept(concept: string): SectionSpec | undefined {
  return SPEC_SECTIONS.find((s) => s.concept === concept);
}

/** 判断一个标题是否命中某章节的别名（大小写不敏感） */
export function headingMatches(heading: string, spec: SectionSpec): boolean {
  const h = heading.trim().toLowerCase();
  return spec.aliases.some((a) => h === a.toLowerCase());
}

/**
 * 取某个章节的正文。
 *
 * @param content 规格全文
 * @param spec 章节定义
 * @returns 章节正文；**章节不存在时返回 null**，章节存在但正文为空时返回空串
 */
export function extractSection(content: string, spec: SectionSpec): string | null {
  const lines = content.split('\n');
  let level = 0;
  let found = false;
  const body: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const headingLevel = heading[1].length;
      if (found) {
        // 同级或更高层的标题 → 本节结束；更低层的（子标题）仍属于本节
        if (headingLevel <= level) break;
        body.push(line);
        continue;
      }
      if (headingMatches(heading[2], spec)) {
        found = true;
        level = headingLevel;
      }
      continue;
    }
    if (found) body.push(line);
  }

  return found ? body.join('\n').trim() : null;
}

/**
 * 规格里缺了哪些必备章节。
 *
 * @returns 缺失的概念名列表（空数组 = 必备章节齐全）
 */
export function missingRequiredSections(content: string): string[] {
  return SPEC_SECTIONS.filter((s) => s.required)
    .filter((s) => extractSection(content, s) === null)
    .map((s) => s.concept);
}
