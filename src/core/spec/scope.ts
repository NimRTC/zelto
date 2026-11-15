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
 * 从规格 Markdown 中提取**全文提到过的**文件路径。
 *
 * 与 `parseScopePaths` 的区别：
 * - `parseScopePaths` 只看「范围」章节，取的是**写集**
 * - 这个函数看**全文**，取的是「规格提到要动哪些文件」
 *
 * 为什么需要后者：实测缺陷 D-4 —— 规格的「需求」章节里写着
 * 「`src/engine/CMakeLists.txt` 如需登记新 `.cpp` 文件，只加一行」，
 * 但「范围」章节（= 写集）里没有这个文件。写集守卫（C9）**正确地**
 * 拦住了 agent 改它，于是 agent 建了新 `.cpp` 却无法登记，链接期才炸：
 *
 *     error LNK2019: 无法解析的外部符号 "nimrtc::engine::build_rtp_packet(...)"
 *
 * 规格说要改 + 写集不允许改 —— 这个矛盾本来在冻结时就能看出来，
 * 但没有任何一道闸门做这个比对。**该写的东西没被授权**，要靠人先看出来。
 *
 * 提取规则：
 * - 反引号包裹的、看起来像路径的（`src/engine/CMakeLists.txt`）
 * - 行内出现的、看起来像路径的（src/engine/CMakeLists.txt）
 * - 排除 URL、排除以 `-` / `*` 开头的 glob 片段、排除绝对路径
 *
 * 「看起来像路径」的判据与 `looksLikePath` 一致：含路径分隔符，
 * 或带已知代码/文档扩展名。
 *
 * @param content 规格文件全文
 * @returns 提到的路径列表（去重，保持出现顺序）
 */
export function parseMentionedPaths(content: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  // 反引号包裹的优先 —— 这是规格里写路径的规范形式
  const backticked = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = backticked.exec(content)) !== null) {
    const candidate = m[1].trim();
    if (!looksLikePath(candidate)) continue;
    const normalized = normalizeMentionedPath(candidate);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }

  // 行内裸路径：只认带已知扩展名的（`src/foo.cpp`），避免把散文当成路径
  const inline = /\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|toml|md|hpp|h|hh|cc|cpp|cxx|c|h|py|sh|txt|cfg|ini|cmake|gradle|mod|sum))\b/g;
  while ((m = inline.exec(content)) !== null) {
    const candidate = m[1];
    const normalized = normalizeMentionedPath(candidate);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }

  return paths;
}

/**
 * 归一化规格里提到的路径。
 *
 * 排除：
 * - 空路径
 * - URL（`https://example.com/x.ts` 的 host 部分会漏进裸路径匹配）
 * - 绝对路径（`/usr/include/x.hpp`、`C:\foo\bar.cpp`）
 * - 带 glob 通配的片段（`**` 之类，不是具体文件）
 */
function normalizeMentionedPath(raw: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  // 去掉尾部标点
  p = p.replace(/[.,;:)]+$/, '');
  if (!p) return null;
  // URL
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return null;
  // 绝对路径
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return null;
  // 含 glob 通配
  if (p.includes('*') || p.includes('?')) return null;
  // 相对前缀 `./` 归一
  if (p.startsWith('./')) p = p.slice(2);
  if (!p) return null;
  return p;
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
