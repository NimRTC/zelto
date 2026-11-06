// Project design generator — calls LLM to reverse-engineer design from project map

import type { LlmAdapter } from '../../core/ports/llm.js';
import type { DesignDoc, DesignModule } from '../../core/design/types.js';
import type { ProjectMap, ProjectModule } from '../../core/project/types.js';
import { PROJECT_DESIGN_PROMPT } from '../prompts/project-design.js';

/**
 * Truncate file lists in project map to avoid exceeding LLM token limits.
 * Keeps first N files per module and adds a count note.
 */
function truncateProjectMap(projectMap: ProjectMap, maxFilesPerModule = 5): ProjectMap {
  const truncateModule = (mod: ProjectModule): ProjectModule => {
    const files = mod.files.length > maxFilesPerModule
      ? [...mod.files.slice(0, maxFilesPerModule), `… and ${mod.files.length - maxFilesPerModule} more files`]
      : mod.files;
    const testFiles = mod.testFiles.length > maxFilesPerModule
      ? [...mod.testFiles.slice(0, maxFilesPerModule), `… and ${mod.testFiles.length - maxFilesPerModule} more test files`]
      : mod.testFiles;
    return {
      ...mod,
      files,
      testFiles,
      submodules: mod.submodules.map(truncateModule),
    };
  };
  return {
    ...projectMap,
    modules: projectMap.modules.map(truncateModule),
  };
}

export async function generateProjectDesign(
  llm: LlmAdapter,
  projectMap: ProjectMap,
  existingId: string,
): Promise<Pick<DesignDoc, 'title' | 'body' | 'modules'>> {
  const truncated = truncateProjectMap(projectMap);
  const projectMapJson = JSON.stringify(truncated, null, 2);
  const prompt = PROJECT_DESIGN_PROMPT.replace('{{PROJECT_MAP}}', projectMapJson);

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是一个高级软件架构师。根据项目扫描结果逆向生成设计文档。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  });

  return parseProjectDesignResponse(response.content, existingId);
}

function parseProjectDesignResponse(
  content: string,
  _existingId: string,
): Pick<DesignDoc, 'title' | 'body' | 'modules'> {
  // Extract title
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Project Design';

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
      ? filesMatch[1].split(/[,，、]/).map((f: string) => f.replace(/^\[|\]$/g, '').trim()).filter(Boolean)
      : [];

    const depsMatch = body.match(/\*\*依赖模块\*\*[：:]\s*(.+)/);
    const dependencies = depsMatch
      ? depsMatch[1].split(/[,，、]/).map((d: string) => d.replace(/^\[|\]$/g, '').trim()).filter(Boolean)
      : [];

    modules.push({ name, description, filePatterns, dependencies });
  }

  return {
    title,
    body: content.trim(),
    modules,
  };
}
