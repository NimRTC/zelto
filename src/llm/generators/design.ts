// Design generator — calls LLM to generate a design document from requirements

import type { LlmAdapter } from '../../adapters/llm/types.js';
import type { DesignDoc, DesignModule } from '../../core/design/types.js';
import { DESIGN_PROMPT } from '../prompts/design.js';

export async function generateDesign(
  llm: LlmAdapter,
  requirementSpec: string,
  existingId: string,
): Promise<Pick<DesignDoc, 'title' | 'body' | 'modules'>> {
  const prompt = DESIGN_PROMPT.replace('{{REQUIREMENT_SPEC}}', requirementSpec);

  const response = await llm.chat({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是一个高级软件架构师。请严格按用户要求生成设计文档。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  });

  return parseDesignResponse(response.content, existingId);
}

function parseDesignResponse(
  content: string,
  _existingId: string,
): Pick<DesignDoc, 'title' | 'body' | 'modules'> {
  // Extract title
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled Design';

  // Extract modules using the "### 模块名" pattern
  const modules: DesignModule[] = [];
  const moduleRegex = /### (.+?)\n([\s\S]*?)(?=\n### |\n## |$)/g;
  let match;

  while ((match = moduleRegex.exec(content)) !== null) {
    const name = match[1].trim();
    const body = match[2].trim();

    const descMatch = body.match(/\*\*职责\*\*[：:]\s*(.+)/);
    const description = descMatch ? descMatch[1].trim() : '';

    const filesMatch = body.match(/\*\*文件路径\*\*[：:]\s*(.+)/);
    const filePatterns = filesMatch
      ? filesMatch[1].split(/[,，、]/).map((f: string) => f.trim()).filter(Boolean)
      : [];

    const depsMatch = body.match(/\*\*依赖模块\*\*[：:]\s*(.+)/);
    const dependencies = depsMatch
      ? depsMatch[1].split(/[,，、]/).map((d: string) => d.trim()).filter(Boolean)
      : [];

    modules.push({ name, description, filePatterns, dependencies });
  }

  return {
    title,
    body: content.trim(),
    modules,
  };
}
