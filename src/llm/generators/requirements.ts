// Requirements generator — calls LLM to generate a requirement document from user input

import type { LlmAdapter } from '../../core/ports/llm.js';
import type { RequirementDoc } from '../../core/requirements/types.js';
import { REQUIREMENTS_PROMPT } from '../prompts/requirements.js';
import { REFINE_REQUIREMENTS_PROMPT } from '../prompts/refine-requirements.js';
import { isPlaceholderTitle, fallbackTitleFrom } from './placeholder-title.js';

export async function generateRequirements(
  llm: LlmAdapter,
  userInput: string,
  existingId: string,
): Promise<Pick<RequirementDoc, 'title' | 'spec' | 'acceptanceCriteria'>> {
  const prompt = REQUIREMENTS_PROMPT.replace('{{USER_INPUT}}', userInput);

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是一个专业的需求分析专家。请严格按用户要求生成需求文档。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  });

  return parseRequirementsResponse(response.content, existingId);
}

/**
 * Refine an existing requirement document with user feedback.
 * Multi-turn iterative editing — keeps the same structure, applies changes.
 */
export async function refineRequirements(
  llm: LlmAdapter,
  currentSpec: string,
  feedback: string,
): Promise<Pick<RequirementDoc, 'title' | 'spec' | 'acceptanceCriteria'>> {
  const prompt = REFINE_REQUIREMENTS_PROMPT
    .replace('{{CURRENT_SPEC}}', currentSpec)
    .replace('{{FEEDBACK}}', feedback);

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是一个专业的需求分析专家。根据用户反馈迭代更新需求文档。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  });

  return parseRequirementsResponse(response.content, '');
}

/**
 * 占位符标题。
 *
 * 提示词模板里写的是 `# <需求标题>`（角括号形式）—— 模型有时会**原样照抄**
 * 模板的结构与文字，于是标题就变成了字面的「需求标题」/「<需求标题>」。
 *
 * 实测缺陷 D-3：需求 / 设计 / 计划的标题永久停在占位符，
 * 追溯链上全是「需求标题」—— 看起来像内容没生成，其实是标题没被识别出来。
 */
function parseRequirementsResponse(
  content: string,
  _existingId: string,
): Pick<RequirementDoc, 'title' | 'spec' | 'acceptanceCriteria'> {
  // Extract title from the first # heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  const rawTitle = titleMatch ? titleMatch[1].trim() : '';

  // D-3：占位符标题不算标题 —— 模型有时会原样照抄提示词模板的「# 需求标题」。
  //
  // 两种情况要分开：
  // - **有 heading 但内容是占位符** → 从正文里捞一句像标题的话顶上
  // - **根本没有 heading** → 承认没标题（'Untitled Requirement'）
  //
  // 后者不能也去捞正文 —— 那会把正文的第一句话当成标题，
  // 让「没有标题」这件事变得不可见（测试 `returns untitled for missing heading`
  // 守的就是这条）。
  let title = '';
  if (titleMatch && !isPlaceholderTitle(rawTitle)) {
    title = rawTitle;
  } else if (titleMatch) {
    title = fallbackTitleFrom(content) ?? 'Untitled Requirement';
  } else {
    title = 'Untitled Requirement';
  }

  // Extract acceptance criteria (lines starting with - [ ])
  const criteriaLines = content.match(/^- \[.?\]\s+.+/gm);
  const acceptanceCriteria = criteriaLines
    ? criteriaLines.map((l) => l.replace(/^- \[.?\]\s*/, '').trim())
    : [];

  return {
    title,
    spec: content.trim(),
    acceptanceCriteria,
  };
}
