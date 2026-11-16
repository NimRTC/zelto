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
 * 已知代码 / 文档 / 配置文件扩展名 —— **唯一真源**。
 *
 * 为什么要集中成一处：之前有**两份**扩展名清单
 * （`looksLikePath` 一份、`parseMentionedPaths` 的行内正则一份），
 * 两份会漂移 —— 一份加了 `cmake`，另一份没加，于是同一个文件
 * 「反引号里能认出来、行内裸写认不出来」。
 *
 * 覆盖：脚本 / 编译 / 文档 / 数据 / 声明 / 样式 / 标记。
 */
const KNOWN_EXTENSIONS = [
  // 脚本与模块
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  // 数据与配置
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'xml', 'plist', 'lock', 'sum', 'mod',
  // 文档
  'md', 'mdx', 'txt', 'rst', 'adoc', 'csv', 'tsv',
  // C / C++ / 其它系统语言
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ipp', 'inl', 'm', 'mm',
  // 脚本语言
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'php', 'pl', 'lua', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  // 样式与标记
  'css', 'scss', 'less', 'html', 'htm', 'vue', 'svelte', 'astro',
  // 构建与配置
  'cmake', 'gradle', 'gyp', 'gypi', 'mk', 'bazel', 'bzl', 'ninja',
  // 图形与资源
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'wasm',
];

/**
 * 无扩展名的常见文件 —— 靠**文件名**识别。
 *
 * 这些文件没有扩展名，靠扩展名白名单永远认不出来：
 * `Makefile`、`Dockerfile`、`CMakeLists.txt`（这个有扩展名但不在常见清单里）、
 * `LICENSE`、`README`。
 *
 * 为什么要单列：`Makefile` 与 `Dockerfile` 在 C++ / Go 项目里是
 * **最常被规格点名的文件**（改依赖、改构建都要动它们），
 * 而 D-4 的判据正是「规格点名了但写集没覆盖」——
 * 认不出这两个文件，这道闸门就在最该拦的地方漏了。
 */
const KNOWN_EXTENSIONLESS_FILENAMES = [
  'makefile', 'gnumakefile', 'dockerfile', 'license', 'licence', 'readme', 'changelog',
  'contributing', 'codeowners', 'notice', 'authors', 'copying', 'install', 'news',
];

/**
 * 一条平路径条目**看起来像路径**吗？
 *
 * 「范围」章节里不只有路径，还有散文式的说明条目（`- 读配置文件`）。
 * 把散文也当写集，冻结准入会去校验一个根本不存在的文件。
 *
 * 判据（满足其一即算路径）：
 *  - 含路径分隔符 `/`（含开头的 `./`）；
 *  - 扩展名属于 `KNOWN_EXTENSIONS`；
 *  - 文件名（无扩展名部分）属于 `KNOWN_EXTENSIONLESS_FILENAMES`。
 */
function looksLikePath(text: string): boolean {
  if (!text) return false;
  if (text.includes('/')) return true;
  return hasKnownExtension(text) || hasKnownExtensionlessName(text);
}

/**
 * 展开花括号简写：`src/x.{hpp,cpp}` → `src/x.hpp` + `src/x.cpp`。
 *
 * 为什么需要它（实测缺陷 D-26）：规格里很自然会写
 * 「新建 `src/engine/src/rtcp_processor.{hpp,cpp}`」——
 * 这是**一个确定的文件集合**的简写。但路径提取器不认识花括号，
 * 于是把 `src/engine/src/rtcp_processor.{hpp,cpp}` 当成**一个**
 * 具体文件名，报出「规格提到它但写集里没有」——
 * 而写集里明明有 `rtcp_processor.hpp` 和 `rtcp_processor.cpp` 两个文件。
 *
 * **闸门误报比闸门漏报更糟**：漏报让人绕过一次检查，
 * 误报让人以为「规格有问题」，于是去改规格 —— 而规格是对的。
 *
 * 展开而不是丢弃：规格确实提到了那两个文件，展开才能保持
 * 「规格点名了但写集没覆盖」这条判据的原意。
 *
 * 展开规则与 shell 的 brace expansion 一致（单层、单组）：
 * - `a{b,c}d` → `abd` + `acd`
 * - 不含逗号的 `{x}` → 原样返回（不是简写）
 * - 嵌套花括号不展开（保持简单；真实规格里不会出现）
 */
function expandBraces(raw: string): string[] {
  const open = raw.indexOf('{');
  if (open === -1) return [raw];
  const close = raw.indexOf('}', open + 1);
  if (close === -1) return [raw];

  const prefix = raw.slice(0, open);
  const suffix = raw.slice(close + 1);
  const body = raw.slice(open + 1, close);

  // 嵌套花括号 —— 不展开，避免歧义
  if (body.includes('{') || body.includes('}')) return [raw];

  const alternatives = body.split(',');
  // 没有逗号 → 不是简写（`{x}` 是文件名的一部分）
  if (alternatives.length < 2) return [raw];

  return alternatives.map((alt) => `${prefix}${alt}${suffix}`);
}

/**
 * 扩展名是否在已知清单里。
 *
 * 大小写不敏感：`CMakeLists.TXT` 与 `CMakeLists.txt` 都要认。
 */
function hasKnownExtension(text: string): boolean {
  const dot = text.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = text.slice(dot + 1).toLowerCase();
  return KNOWN_EXTENSIONS.includes(ext);
}

/**
 * 无扩展名的文件名是否在已知清单里。
 *
 * 只看 basename —— `build/Makefile` 的 basename 是 `Makefile`。
 */
function hasKnownExtensionlessName(text: string): boolean {
  const base = text.slice(text.lastIndexOf('/') + 1).trim().toLowerCase();
  if (!base) return false;
  // 带扩展名的不走这条判据（由 hasKnownExtension 管）
  if (base.includes('.')) {
    // `CMakeLists.txt` 这种「名字里带点但扩展名不是代码类」的另算
    return KNOWN_EXTENSIONLESS_FILENAMES.includes(base);
  }
  return KNOWN_EXTENSIONLESS_FILENAMES.includes(base);
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
    for (const candidate of expandBraces(m[1].trim())) {
      if (!looksLikePath(candidate)) continue;
      const normalized = normalizeMentionedPath(candidate);
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      paths.push(normalized);
    }
  }

  // 行内裸路径：只认带已知扩展名的（`src/foo.cpp`），避免把散文当成路径。
  //
  // 扩展名清单与 `looksLikePath` **同源**（`KNOWN_EXTENSIONS`）——
  // 之前这里是另一份手抄的清单，两份会漂移。
  //
  // **前置断言**解决两类误抓：
  // - URL 的 host 段：`example.com/docs/guide.md` → 前面是 `://`，
  //   用 `(?<![/:\\w])` 排除（`:` 与 `/` 都在排除集里）
  // - 绝对路径：`/usr/include/x.hpp` → 前面是 `/`；`C:\foo\bar.cpp` → 前面是 `:`
  const extPattern = KNOWN_EXTENSIONS.map((e) => e.replace('.', '\\.')).join('|');
  const inline = new RegExp(
    `(?<![/:\\\\\\w.])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\\.(?:${extPattern}))(?![A-Za-z0-9_.-])`,
    'gi',
  );
  while ((m = inline.exec(content)) !== null) {
    const candidate = m[1];
    const normalized = normalizeMentionedPath(candidate);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }

  // 行内裸的**无扩展名文件**（`Makefile`、`Dockerfile`）——
  // 这些在 C++ / Go 项目里最常被规格点名，却完全没有扩展名可认。
  //
  // 前置断言同样排除 URL host 与绝对路径。
  const namePattern = KNOWN_EXTENSIONLESS_FILENAMES.join('|');
  const extensionless = new RegExp(
    `(?<![/:\\\\\\w.])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*/(?:${namePattern})|(?<![/:\\\\\\w.])(?:${namePattern}))(?![A-Za-z0-9_.-])`,
    'gi',
  );
  while ((m = extensionless.exec(content)) !== null) {
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
 * - 残留的花括号（`a.{x,y}` 展开失败时不是具体文件）
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
  // 残留花括号 —— 展开失败的花括号简写不是具体文件（D-26）。
  // 报一个不存在的文件名比不报更糟：闸门误报会把人引去改正确的规格。
  if (p.includes('{') || p.includes('}')) return null;
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
