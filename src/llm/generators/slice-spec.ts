// Slice spec 生成器 —— 把「已确认的意图」落成「信息量足够的切片规格」
//
// 背景：require → design → plan → confirm 这一路精心生成的意图，此前在落地成
// 切片规格时被压成一句「完成 XXX / 全部测试通过」。agent 拿到的实现依据
// 信息量接近零 —— 规格形同摆设（ADR-034 §2）。
//
// 两个刻意的设计：
//
// 1. **产出永远是草稿**（C7）：这里生成的内容进的是草稿路径，要人 `confirm`
//    之后才写进正式规格。人没确认的规格不参与任何判定。
//
// 2. **确定性降级不自己编验收标准**：没有 LLM 时，规格里的验收标准只能来自
//    **人已批准的需求条目**。没有需求条目就留明确的「待人确认」占位 ——
//    宁可让人被拦住（ADR-032 §4 方案三），也不制造看着完整的空追溯链。
//
// C2: 只依赖 core/ports，不 import adapters/。

import type { LlmAdapter } from '../../core/ports/llm.js';
import { SLICE_SPEC_PROMPT } from '../prompts/slice-spec.js';

/** 生成一份切片规格所需要的已知信息 */
export interface SliceSpecInput {
  /** 切片 id */
  sliceId: string;
  /** 切片标题 */
  title: string;
  /** 所属模块 */
  module: string;
  /** 写集路径 */
  writes: string[];
  /** 所属版本 */
  version: string;
  /** 该切片关联的需求条目（人批准的出处） */
  requirements?: string[];
  /** 所属版本的前置切片 */
  prerequisites?: string[];
}

/** 未确认处的占位符 —— 明确标记「这里需要人填」，不编造内容 */
export const TBD_PLACEHOLDER = 'TBD（需人确认）';

/** 没有可物化的验收标准时的占位（**刻意不写成编号条目**） */
export const NO_CRITERIA_PLACEHOLDER =
  '（待人确认：本片尚无已批准的需求条目，验收标准需人补齐后再确认规格）';

/**
 * 生成切片规格草稿。
 *
 * 有 LLM 时走模型（草稿），没有 LLM 时走确定性降级路径，
 * 保证规格**结构完整**、验收标准**不是空壳**。
 *
 * @param llm LLM 适配器；null 时走确定性降级
 */
export async function generateSliceSpec(
  llm: LlmAdapter | null,
  input: SliceSpecInput,
): Promise<string> {
  if (!llm) {
    return buildDeterministicSliceSpec(input);
  }

  const prompt = SLICE_SPEC_PROMPT
    .replace('{{SLICE_ID}}', input.sliceId)
    .replace('{{TITLE}}', input.title)
    .replace('{{MODULE}}', input.module)
    .replace('{{VERSION}}', input.version)
    .replace('{{WRITES_JSON}}', JSON.stringify(input.writes, null, 2))
    .replace('{{REQUIREMENTS_JSON}}', JSON.stringify(input.requirements ?? [], null, 2))
    .replace('{{PREREQUISITES_JSON}}', JSON.stringify(input.prerequisites ?? [], null, 2));

  const response = await llm.chat({
    messages: [
      {
        role: 'system',
        content:
          '你是一个资深工程师，为单个切片撰写实现规格。只输出 Markdown，不要额外解释。',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.5,
    maxTokens: 2048,
  });

  const content = response.content.trim();

  // 模型输出不可靠时（空、缺必备章节、验收标准是空壳）退回确定性降级，
  // 规格的结构完整性不能靠模型心情。
  if (!isUsableSpec(content)) {
    return buildDeterministicSliceSpec(input);
  }

  return normalizeSpec(content, input);
}

/**
 * 确定性降级：没有 LLM 时生成结构完整的规格骨架。
 *
 * 已知信息填进对应章节，未知处留**明确占位符**，不编造内容。
 *
 * 验收标准只从**人已批准的需求条目**推导 —— 需求为空时留占位，
 * 不写编号条目（写了就会被物化成需求追溯，于是「追溯合格」变成工具替人批准）。
 */
export function buildDeterministicSliceSpec(input: SliceSpecInput): string {
  const requirements = input.requirements ?? [];
  const prerequisites = input.prerequisites ?? [];

  const lines: string[] = [
    `# Slice: ${input.sliceId}`,
    '',
    '## 目的',
    `版本 ${input.version} — ${input.title}${input.module ? `（模块 ${input.module}）` : ''}`,
    '',
    '## 范围',
    // 写集为空时这里留空 —— 空范围是真实状态，编一条占位路径反而会让人以为
    // 有个 TBD 文件要改。缺信息这件事由「风险」章节说明。
    ...input.writes.map((w) => `- \`${w}\``),
    '',
  ];

  if (prerequisites.length > 0) {
    lines.push('## 前置切片', ...prerequisites.map((p) => `- ${p}`), '');
  }

  if (requirements.length > 0) {
    lines.push('## 需求', ...requirements.map((r) => `- ${r}`), '');
  }

  lines.push('## 验收标准');

  if (requirements.length > 0) {
    // 验收标准来自人批准的需求条目 —— 物化出来的追溯出处仍然是人的话，不是工具的话
    requirements.forEach((req, i) => {
      lines.push(`${i + 1}. 满足需求「${req}」；验证方式：有对应测试或可核对的产出`);
    });
  } else {
    lines.push(NO_CRITERIA_PLACEHOLDER);
  }

  lines.push('', '## 风险', ...buildRiskItems(input), '');

  return lines.join('\n');
}

/** 风险条目 —— 只写已知的风险，不编造 */
function buildRiskItems(input: SliceSpecInput): string[] {
  const risks: string[] = [];
  if (input.writes.length === 0) {
    risks.push('- 写集为空：本切片的改动边界未确定，越界风险无法评估');
  }
  if (!input.requirements || input.requirements.length === 0) {
    risks.push('- 未关联需求条目：追溯链在本片断开（ADR-032）');
  }
  risks.push('- 实现细节与测试策略：' + TBD_PLACEHOLDER);
  return risks;
}

/**
 * 判断模型产出的规格是否可用。
 *
 * 必备章节齐全（目的 / 验收标准）且验收标准不是空壳，才算可用。
 */
export function isUsableSpec(content: string): boolean {
  if (!content || content.trim().length === 0) return false;

  const hasSummary = /^#{1,6}\s+(Summary|Purpose|目的)\s*$/im.test(content);
  const hasAcceptance = /^#{1,6}\s+(Acceptance Criteria|Acceptance|验收标准)\s*$/im.test(content);
  if (!hasSummary || !hasAcceptance) return false;

  // 验收标准不能是空壳：既要有编号条目，也不能是「完成 XXX」这类废话
  const acceptanceBody = extractAcceptanceBody(content);
  if (!acceptanceBody) return false;
  const items = acceptanceBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s+\S/.test(l));
  if (items.length === 0) return false;

  return !items.every((item) => isVacuousCriterion(item));
}

/** 空壳验收标准：没有可验证内容的套话 */
function isVacuousCriterion(item: string): boolean {
  const text = item.replace(/^\d+\.\s*/, '').trim();
  if (text.length === 0) return true;
  const vacuous = [
    /^完成\s*.+$/,
    /^全部测试通过$/,
    /^测试通过$/,
    /^实现功能$/,
    /^代码正常$/,
    /^无$/,
  ];
  return vacuous.some((re) => re.test(text));
}

/** 取「验收标准」章节正文 */
function extractAcceptanceBody(content: string): string | null {
  const lines = content.split('\n');
  let inSection = false;
  let level = 0;
  const body: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const headingLevel = heading[1].length;
      if (inSection) {
        if (headingLevel <= level) break;
        body.push(line);
        continue;
      }
      if (/^(Acceptance Criteria|Acceptance|验收标准)$/i.test(heading[2].trim())) {
        inSection = true;
        level = headingLevel;
      }
      continue;
    }
    if (inSection) body.push(line);
  }

  return inSection ? body.join('\n') : null;
}

/**
 * 归一化模型产出：确保切片标题存在。
 *
 * 不改写模型写出的实质内容，只补齐结构性的东西。
 */
function normalizeSpec(content: string, input: SliceSpecInput): string {
  const spec = content.replace(/\r\n/g, '\n');

  if (!/^#\s+Slice:/m.test(spec)) {
    return `# Slice: ${input.sliceId}\n\n${spec}`;
  }

  return spec.endsWith('\n') ? spec : `${spec}\n`;
}
