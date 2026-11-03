// Spec scope parsing — 从规格 Markdown 的「范围」章节解析写集路径
//
// C3: 纯字符串解析，确定性，不调模型、不触网

/**
 * 从规格 Markdown 中解析「范围 / Scope」章节下的反引号路径。
 *
 * 识别的章节标题：包含「范围」「scope」「range」（大小写不敏感）。
 * 识别的条目格式：`- \`path/to/file.ts\`` 或 `* \`path/**\``。
 *
 * 只取章节内**第一个条目**所处的缩进层级——嵌套子条目（如 `- manager.ts`）
 * 是对上一条目的说明，不是独立的写集路径。
 *
 * @param content 规格文件全文
 * @returns 解析到的路径列表（保持出现顺序，可能为空）
 */
export function parseScopePaths(content: string): string[] {
  const paths: string[] = [];
  const lines = content.split('\n');

  let inScope = false;
  let bulletIndent: number | null = null;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      inScope = /范围|scope|range/i.test(line);
      bulletIndent = null;
      continue;
    }
    if (!inScope) continue;

    const match = line.match(/^(\s*)[-*]\s+`([^`]+)`/);
    if (!match) continue;

    const indent = match[1].length;
    if (bulletIndent === null) {
      bulletIndent = indent;
    } else if (indent !== bulletIndent) {
      // 嵌套条目，跳过
      continue;
    }

    const p = match[2].trim();
    if (p && !paths.includes(p)) paths.push(p);
  }

  return paths;
}

/**
 * 从规格 Markdown 中解析「前置切片 / Prerequisites」章节下的切片 id 列表。
 *
 * 识别的章节标题：包含「前置」「prerequisite」「depends」（大小写不敏感）。
 * 识别的条目格式：`- slice-id` 或 `- \`slice-id\``。
 *
 * 这是依赖图（`core/sched/depgraph.ts`）的主要数据来源——
 * 切片之间的先后关系写在规格里，而不是散落在命令行参数里。
 *
 * @param content 规格文件全文
 * @returns 前置切片 id 列表（保持出现顺序，可能为空）
 */
export function parsePrerequisites(content: string): string[] {
  const prereqs: string[] = [];
  const lines = content.split('\n');

  let inPrereq = false;
  let bulletIndent: number | null = null;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      inPrereq = /前置|prerequisite|depends/i.test(line);
      bulletIndent = null;
      continue;
    }
    if (!inPrereq) continue;

    const match = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (!match) continue;

    const indent = match[1].length;
    if (bulletIndent === null) {
      bulletIndent = indent;
    } else if (indent !== bulletIndent) {
      continue;
    }

    // 条目内容可能是 `slice-id` 或 `slice-id（说明文字）`
    const raw = match[2].trim().replace(/^`|`$/g, '').split(/[（(]/)[0].trim();
    if (raw && !prereqs.includes(raw)) prereqs.push(raw);
  }

  return prereqs;
}

/**
 * 从规格 Markdown 中解析「验收标准 / Acceptance Criteria」章节下的编号条目。
 *
 * @param content 规格文件全文
 * @returns 验收标准文本列表（保持出现顺序）
 */
export function parseAcceptanceCriteria(content: string): string[] {
  const criteria: string[] = [];
  const lines = content.split('\n');

  let inAcceptance = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inAcceptance = /验收标准|acceptance|criter/i.test(line);
      continue;
    }
    if (!inAcceptance) continue;
    const match = line.match(/^\s*\d+\.\s+(.+)/);
    if (match) {
      criteria.push(match[1].trim());
    }
  }

  return criteria;
}
