// Clarify prompt — LLM-powered question generation for slice clarification
//
// Given slice data, the LLM identifies gaps and generates structured questions.
// Output is always a suggestion — never a decision (C7).

export function buildClarifySystemPrompt(): string {
  return `你是一个 AI 编程驾驶舱的澄清引擎。你的职责是分析切片数据，找出信息缺口，生成结构化问题。

你的输出必须是 JSON 格式的数组，每个元素包含：
- "id": 唯一标识（用切片ID-类别-轮次，如 "my-slice-reqs-1"）
- "text": 问题的中文描述
- "candidates": 候选项数组（2-4 个选项）
- "default": 默认值（从候选中选一个）
- "impact": 影响程度（"high" | "medium" | "low"）
- "reversibility": 可逆性（"high" | "medium" | "low"）
- "basis": 依据来源
- "ifUndecided": 如果不确定的建议

可能的类别（用于 id 中的 category 部分）：
- reqs: 需求追溯
- contracts: 契约定义
- tests: 验收测试
- writes: 写集
- oracle: Oracle 来源

只输出 JSON 数组，不要 Markdown 包裹，不要其他文字。如果切片信息完整则输出 []。`;
}

export function buildClarifyUserPrompt(slice: {
  id: string;
  title: string;
  writes: string[];
  requirements: string[];
  contracts: string[];
  tests: string[];
  acceptanceDir: string | null;
  oracleSrc: string | null;
  round: number;
}): string {
  const lines: string[] = [
    `请为以下切片生成澄清问题（第 ${slice.round} 轮）：`,
    '',
    `切片 ID: ${slice.id}`,
    `标题: ${slice.title}`,
    `写集: ${slice.writes.length > 0 ? slice.writes.join(', ') : '（未定义）'}`,
    `需求追溯: ${slice.requirements.length > 0 ? slice.requirements.join(', ') : '（未定义）'}`,
    `契约: ${slice.contracts.length > 0 ? slice.contracts.join(', ') : '（未定义）'}`,
    `验收测试: ${slice.tests.length > 0 ? slice.tests.join(', ') : '（未定义）'}`,
    `验收目录: ${slice.acceptanceDir ?? '（未设置）'}`,
    `Oracle 来源: ${slice.oracleSrc ?? '（未设置）'}`,
    '',
    '请基于以上信息，识别缺失的部分并生成问题。',
    `如果所有字段都已定义且合理，返回 []。`,
  ];

  return lines.join('\n');
}
