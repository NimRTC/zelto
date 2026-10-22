// Requirements generator — calls LLM to generate a requirement document from user input

import type { LlmAdapter } from '../../adapters/llm/types.js';
import type { RequirementDoc } from '../../core/requirements/types.js';
import { REQUIREMENTS_PROMPT } from '../prompts/requirements.js';

export async function generateRequirements(
  llm: LlmAdapter,
  userInput: string,
  existingId: string,
): Promise<Pick<RequirementDoc, 'title' | 'spec' | 'acceptanceCriteria'>> {
  const prompt = REQUIREMENTS_PROMPT.replace('{{USER_INPUT}}', userInput);

  const response = await llm.chat({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是一个专业的需求分析专家。请严格按用户要求生成需求文档。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  });

  return parseRequirementsResponse(response.content, existingId);
}

function parseRequirementsResponse(
  content: string,
  _existingId: string,
): Pick<RequirementDoc, 'title' | 'spec' | 'acceptanceCriteria'> {
  // Extract title from the first # heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled Requirement';

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
