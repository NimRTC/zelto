// Spec scope parsing — 从规格 Markdown 的「范围」章节解析写集路径
//
// C3: 纯字符串解析，确定性，不调模型、不触网

/**
 * 从规格 Markdown 中解析「范围 / Scope」章节下的路径。
 *
 * 识别的章节标题：包含「范围」「scope」「range」（大小写不敏感）。
 * 识别的条目格式：`- \`path/to/file.ts\`` 或 `- path/to/file.ts`
 *（反引号可有可无 —— 规格是人写的，两种写法都常见）。
 *
 * 只取章节内**第一个条目**所处的缩进层级——嵌套子条目（如 `- manager.ts`）
 * 是对上一条目的说明，不是独立的写集路径。
 *
 * **为什么反引号可有可无**：写规格的自然写法是不加反引号的
 * （`- src/core/audit/manager.ts`），而解析器只认反引号的话，
 * 写集就是空的 —— 切片拿不到写集，冻结准入直接卡住。
 * 「人怎么写规格」与「解析器认什么」必须对齐。
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

    // 反引号可有可无：有就取反引号里的，没有就取整条（去掉尾部说明）
    const match = line.match(/^(\s*)[-*]\s+(?:`([^`]+)`(.+)?|(.+?))\s*$/);
    if (!match) continue;

    const indent = match[1].length;
    if (bulletIndent === null) {
      bulletIndent = indent;
    } else if (indent !== bulletIndent) {
      // 嵌套条目，跳过
      continue;
    }

    // 反引号分支：路径是第 2 组；平路径分支：路径是第 4 组
    const p = (match[2] ?? match[4] ?? '').trim();
    // 平路径的尾部说明（`path - 说明`）去掉：只留路径本身
    const cleaned = match[2] ? p : p.replace(/\s+[-—–]\s+.*$/, '').trim();
    // 平路径必须**像路径**才收：`- Read the config file` 是散文说明，不是写集。
    // 判据：含路径分隔符，或带已知代码/文档扩展名。
    if (cleaned && !paths.includes(cleaned) && (match[2] || looksLikePath(cleaned))) {
      paths.push(cleaned);
    }
  }

  return paths;
}

/**
 * 一条平路径条目**看起来像路径**吗？
 *
 * 「范围」章节里不只有路径，还有散文式的说明条目（`- 读配置文件`）。
 * 把散文也当写集，冻结准入会去校验一个根本不存在的文件。
 *
 * 判据（满足其一即算路径）：
 *  - 含路径分隔符 `/`（含开头的 `./`）；
 *  - 扩展名属于常见的代码/文档/配置类型。
 */
function looksLikePath(text: string): boolean {
  if (!text) return false;
  if (text.includes('/')) return true;
  return /\.(ts|tsx|js|mjs|cjs|json|ya?ml|toml|md|hpp|h|cc|cpp|cxx|py|sh|txt|cfg|ini)$/i.test(text);
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
 * **条目可以跨行**（ADR-050）：编号行后面的缩进续行是同一条目的一部分。
 * 只取编号行本行的话，「验证方式：……」整段丢掉，剩下的用例名只有半句。
 *
 * @param content 规格文件全文
 * @returns 验收标准文本列表（保持出现顺序）
 */
export function parseAcceptanceCriteria(content: string): string[] {
  const criteria: string[] = [];
  const lines = content.split('\n');

  let inAcceptance = false;
  let current: string | null = null;

  const flush = (): void => {
    if (current !== null) {
      const text = current.trim();
      if (text) criteria.push(text);
      current = null;
    }
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      inAcceptance = /验收标准|acceptance|criter/i.test(line);
      continue;
    }
    if (!inAcceptance) continue;

    const match = line.match(/^\s*\d+\.\s+(.+)/);
    if (match) {
      flush();
      current = match[1].trim();
      continue;
    }
    // 续行：缩进、非空、且不是新的列表项 → 接上一条
    if (current !== null && line.trim() && /^\s{2,}/.test(line) && !/^\s*([-*+]|\d+\.)\s/.test(line)) {
      current = `${current} ${line.trim()}`;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    flush();
  }
  flush();

  return criteria;
}
