// Design generator — calls LLM to generate a design document from requirements

import type { LlmAdapter } from '../../core/ports/llm.js';
import type { DesignDoc } from '../../core/design/types.js';
import { parseDesignModules } from '../../core/design/parse.js';
import { DESIGN_PROMPT } from '../prompts/design.js';
import { REFINE_DESIGN_PROMPT } from '../prompts/refine-design.js';
import { chatWithOverflowFallback } from '../overflow-fallback.js';
import { isPlaceholderTitle, fallbackTitleFrom } from './placeholder-title.js';

/**
 * 生成设计文档。
 *
 * `projectStructure` 是**可选**的真实仓库摘要（见 `llm/project-context.ts`）。
 * 有它时模型能看见真实目录与文件，写出来的「文件路径」才落得进切片写集；
 * 没有它时退回旧行为（只凭需求文本臆造模块）—— 那条路在老项目上踩过，
 * 设计会编出不存在的目录（nimrtc v1.4 演练，2026-11-20）。
 */
export async function generateDesign(
  llm: LlmAdapter,
  requirementSpec: string,
  existingId: string,
  projectStructure?: string,
): Promise<Pick<DesignDoc, 'title' | 'body' | 'modules'>> {
  const injectable = projectStructure && projectStructure.trim() ? projectStructure : '（本次没有提供项目扫描结果 —— 若需求没有写明目录结构，模块路径只写「沿用现有模块」而不要虚构。）';

  // ZD-002：装不下就缩摘要重试一次。
  //
  // 摘要**已经有**字符预算（`MAX_SUMMARY_CHARS`），但那个预算猜不出
  // 模型端的 token 上限 —— 12k 字符在 DeepSeek 上是安全的（163840 token），
  // 在上下文更小的模型上就未必。实测踩到的是：摘要 1.1MB（预算加之前）
  // 直接 400「number of input tokens (373385) has exceeded max_seq_len」。
  //
  // 缩的是**注入的仓库摘要**，不是需求正文 —— 缩需求正文就等于丢需求。
  // 重试仍失败 → 抛原始错误（不静默降级成「空摘要」，
  // 那会让模型拿残缺上下文编路径，而人看不出来）。
  const response = await chatWithOverflowFallback(
    llm,
    (structure) =>
      DESIGN_PROMPT
        .replace('{{PROJECT_STRUCTURE}}', structure)
        .replace('{{REQUIREMENT_SPEC}}', requirementSpec),
    injectable,
    {
      maxRetries: 1,
      request: {
        messages: [
          { role: 'system', content: '你是一个高级软件架构师。请严格按用户要求生成设计文档。' },
        ],
        temperature: 0.7,
        maxTokens: 4096,
      },
    },
  );

  return parseDesignResponse(response.content, existingId);
}

/**
 * Refine an existing design document with user feedback.
 * Multi-turn iterative editing — keeps the same structure, applies changes.
 */
export async function refineDesign(
  llm: LlmAdapter,
  currentBody: string,
  feedback: string,
): Promise<Pick<DesignDoc, 'title' | 'body' | 'modules'>> {
  const prompt = REFINE_DESIGN_PROMPT
    .replace('{{CURRENT_DESIGN}}', currentBody)
    .replace('{{FEEDBACK}}', feedback);

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是一个高级软件架构师。根据反馈迭代更新设计文档。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  });

  return parseDesignResponse(response.content, '');
}

function parseDesignResponse(
  content: string,
  _existingId: string,
): Pick<DesignDoc, 'title' | 'body' | 'modules'> {
  // Extract title
  const titleMatch = content.match(/^#\s+(.+)/m);
  const rawTitle = titleMatch ? titleMatch[1].trim() : '';

  // D-3：占位符标题不算标题（模型有时会原样照抄提示词模板的「# 设计标题」）。
  //
  // 与需求侧同口径：
  // - 有 heading 且不是占位符 → 用它
  // - 有 heading 但内容是占位符 → 从正文里捞一句像标题的话顶上
  // - 根本没有 heading → 承认没标题（'Untitled Design'）
  let title = '';
  if (titleMatch && !isPlaceholderTitle(rawTitle)) {
    title = rawTitle;
  } else if (titleMatch) {
    title = fallbackTitleFrom(content) ?? 'Untitled Design';
  } else {
    title = 'Untitled Design';
  }

  // 模块声明的解析口径与「项目基线设计」那条路径共用一份（core/design/parse.ts）
  const modules = parseDesignModules(content);

  return {
    title,
    body: content.trim(),
    modules,
  };
}
