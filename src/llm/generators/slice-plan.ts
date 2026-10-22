// Slice plan generator — calls LLM to generate version + slice plan from design

import type { LlmAdapter } from '../../adapters/llm/types.js';
import type { DesignModule } from '../../core/design/types.js';
import type { VersionPlan, Version } from '../../core/version/types.js';
import { SLICE_PLAN_PROMPT } from '../prompts/slice-plan.js';

interface LlmSlicePlan {
  title: string;
  versions: Array<{
    version: string;
    description: string;
    dependsOn: string[];
    slices: Array<{
      id: string;
      module: string;
      title: string;
      writes: string[];
    }>;
  }>;
}

export async function generateSlicePlan(
  llm: LlmAdapter,
  designBody: string,
  modules: DesignModule[],
  existingId: string,
): Promise<Pick<VersionPlan, 'title' | 'versions'>> {
  const modulesJson = JSON.stringify(
    modules.map((m) => ({
      name: m.name,
      filePatterns: m.filePatterns,
      dependencies: m.dependencies,
    })),
    null,
    2,
  );

  const prompt = SLICE_PLAN_PROMPT
    .replace('{{DESIGN_BODY}}', designBody)
    .replace('{{MODULES_JSON}}', modulesJson);

  const response = await llm.chat({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是一个项目管理专家。严格按格式输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  });

  return parseSlicePlanResponse(response.content, existingId);
}

function parseSlicePlanResponse(
  content: string,
  _existingId: string,
): Pick<VersionPlan, 'title' | 'versions'> {
  // Try to extract JSON from the response (it may be wrapped in markdown code blocks)
  let jsonStr = content.trim();

  // Remove markdown code block markers if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr) as LlmSlicePlan;

  const versions: Version[] = parsed.versions.map((v) => ({
    version: v.version,
    dependsOn: v.dependsOn,
    description: v.description,
    slices: v.slices.map((s) => ({
      id: s.id,
      module: s.module,
      title: s.title,
      writes: s.writes,
      specPath: `specs/slices/${s.id}.md`,
      state: 'draft',
    })),
    integrationTestDir: `tests/acceptance/${v.version}/`,
    status: 'planned' as const,
  }));

  return {
    title: parsed.title ?? 'Version Plan',
    versions,
  };
}
