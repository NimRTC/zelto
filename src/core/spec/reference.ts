// 规格「参考」章节的识别 —— 「哪些路径只是被引用，不是被要求修改」
//
// 为什么需要这个模块（实测缺陷 D-4 的误报，nimrtc-zelto v2）：
//
//   D-4 规则（`evaluateWriteSetCoverage`）问的是
//   「规格提到的文件，写集覆盖到了吗」—— 覆盖不到就拒绝冻结。
//   这条规则的存在意义很好：**规格说要改 + 写集不允许改 = 这个矛盾
//   在冻结时就能看出来**，不用等 agent 撞上写集守卫、在链接期才发现。
//
//   但 D-4 的输入是 `parseMentionedPaths(specContent)` ——
//   **规格全文**里提到的所有路径。这就把两类完全不同的东西混在了一起：
//
//     1. 「要改的文件」—— `src/engine/CMakeLists.txt` 如需登记新 `.cpp`，
//        只加一行 → 必须在写集里，否则 agent 建了新文件却无法登记，
//        链接期才炸（LNK2019）。
//     2. 「拿来读的东西」—— 「对应 `docs/plan/ai-game-demo-plan.md` §5.1」
//        → **只读**，agent 读了照做就行，不该要求它有权改那份规划文档。
//
//   现实里第 2 类极其常见：几乎每份规格都要指明「需求出自哪份文档、
//   对应哪一节」。而规划文档往往**本来就不该被 agent 改**
//   （它是人批准的出处，改了就失去意义）。
//
//   把第 2 类当成第 1 类 → 冻结被拦，而规格**完全没问题**。
//   这是典型的**闸门误报** —— 误报比漏报更糟：
//   漏报让人绕过一次检查，误报让人以为「规格有问题」，
//   于是去改正确的规格（AGENTS.md：「遇到不确定时停下来问」）。
//
// 所以这里识别「只读引用」。三条通道：
//
//   A. 参考章节 —— 「## 参考」/「## References」章节里提到的路径
//   B. 指路措辞 —— 「对应 / 参见 / 详见 / see / per …」后面跟着的路径
//   C. 只读标记 —— 「不改动 X」「X 是只读的」「保持 X 原样」这类
//      **明确说「别动它」**的说法后面跟着的路径
//
// C 通道的存在是因为有一类路径**既不是文档、也不在参考章节里**，
// 但同样明确是只读的：「fork `examples/demo-agent-gateway/xxx.cpp` 出
// `examples/demo-agent-realtime/`」—— 那份源文件是**被复制**的，
// 不是被改的（改了它就等于改了原 demo，违反「不改动原行为」）。
//
// C3: 纯文本解析，确定性，不调模型、不触网。

/** 参考类章节的标题识别（与 scope.ts 的章节识别同口径）。 */
const REFERENCE_SECTION = /参考|引用|参照|reference|refer/i;

/**
 * 「指路措辞」—— 这些词后面跟的路径是**被读的**，不是**被改的**。
 *
 * 中英文各一组。词后面通常紧跟路径（可带反引号）。
 */
const REFERENCE_PHRASES = [
  // 中文
  '对应', '参见', '详见', '依据', '摘自', '出自', '来源于', '需求出自',
  '格式见', '定义见', '遵循', '参照', '出自于',
  // 英文
  'see ', 'refer to', 'reference', 'per ', 'according to', 'as defined in',
  'described in', 'based on',
];

/**
 * 「只读标记」—— 这些词后面跟的路径是**明确不许改**的。
 *
 * 比指路措辞更强：指路只是「顺便看看」，只读标记是**明说不许动**。
 * 所以只读标记**不限扩展名** —— 源码也可以是只读的
 * （「fork 源文件」「不改动原 demo 的行为」）。
 */
const READONLY_PHRASES = [
  // 中文
  '不改动', '不修改', '不要改', '不得改', '不许改', '保持原样', '保持不变',
  '原样保留', '只读', '不改', '复制自', '派生自',
  // 英文
  'do not modify', "don't modify", 'do not change', "don't change",
  'read-only', 'readonly', 'leave unchanged', 'copy from', 'forked from',
  // 「fork X 出 Y」—— X 是**被复制**的源，不是被改的
  'fork',
];

/**
 * 「文档类」扩展名 —— **指路措辞**只豁免这些扩展名。
 *
 * 为什么指路只限文档：判据是「指路 = 拿来读的」，
 * 而读**文档**是常态（需求出处、格式定义、参考章节）；
 * 读**源码**也是读，但源码路径出现在规格里，往往正是
 * 「要改这个文件」的意思（D-4 的原始案例：
 * 「`src/engine/CMakeLists.txt` 如需登记新 `.cpp` 文件，只加一行」）。
 *
 * 指路豁免范围放宽到源码 = 漏报（该写没授权的文件被放过），
 * 那比误报更糟 —— 误报只是多看一眼，漏报是链接期才炸。
 *
 * 但**只读标记**不限扩展名 —— 它是明说「别动」，语义更强。
 */
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst', 'adoc']);

/** 候选路径：反引号包裹的，或带扩展名的裸路径。 */
const BACKTICKED = /`([^`\n]+)`/g;

/**
 * 反引号里的内容**不是**路径 —— 命令行、选项、标识符等。
 *
 * 病灶（ZD-006）：规格里写
 * 「验证方式：运行 `node --test tests/acceptance/x/acceptance.test.cjs`」
 * —— 反引号里是一整条**命令**，不是路径。把它当路径 → 报
 * 「规格提到 node --test tests/... 但它不在写集里」。
 *
 * 判据：反引号内容里含**空白**就是命令/短语，不是路径。
 * 路径里不该有空格（真要有，`\ ` 转义或 `%20`）。
 */
function looksLikeCommand(candidate: string): boolean {
  return /\s/.test(candidate.trim());
}
// 路径段允许非 ASCII 字母 —— 中文目录名（`docs/其它.md`）是真实存在的，
// 只认 ASCII 会让含中文的路径既不被识别为「提到」也不被识别为「引用」。
const INLINE_PATH = /(?<![/:\\\w.])([\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*\.[A-Za-z0-9]{1,6})(?![A-Za-z0-9_.-])/gu;

/**
 * 一个候选是不是「文档类路径」。
 *
 * @returns 规范化后的路径，或 null（不是文档类路径）
 */
function asDocPath(candidate: string): string | null {
  const cleaned = cleanCandidate(candidate);
  if (!cleaned) return null;
  const dot = cleaned.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = cleaned.slice(dot + 1).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) return null;
  return cleaned;
}

/**
 * 一个候选是不是「任何类型的路径」—— 只读标记通道用这个。
 *
 * @returns 规范化后的路径，或 null
 */
function asAnyPath(candidate: string): string | null {
  const cleaned = cleanCandidate(candidate);
  if (!cleaned) return null;
  // 至少要有目录分隔符，或者是带扩展名的文件名
  const dot = cleaned.lastIndexOf('.');
  const hasExt = dot > 0 && /^[A-Za-z0-9]{1,6}$/.test(cleaned.slice(dot + 1));
  if (!cleaned.includes('/') && !hasExt) return null;
  return cleaned;
}

/** 候选的通用清洗：去 glob / URL / 绝对路径 / 尾部标点。 */
function cleanCandidate(candidate: string): string | null {
  let cleaned = candidate
    .replace(/[.,;:，。；：)\]】」』]+$/, '')
    .replace(/[（(【「『].*$/, '')
    .trim();
  if (!cleaned) return null;
  if (cleaned.includes('*') || cleaned.includes('?')) return null; // glob
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cleaned)) return null; // URL
  if (cleaned.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cleaned)) return null; // 绝对路径
  return cleaned.replace(/^\.\//, '');
}

/**
 * 文本前面有没有某个措辞（措辞必须**紧邻**路径）。
 *
 * 「紧邻」的判据：路径之前的那段文字，去掉尾部空白与标点后，
 * **以该措辞结尾**。
 *
 * 不能把「见」这种单字当成宽判据（「见下面的表格」不是引用路径），
 * 所以措辞后面必须紧跟**像路径**的内容。
 */
function hasLeadingPhrase(textBefore: string, phrases: string[]): boolean {
  // 去掉尾部的 markdown 强调标记（`**不改动**` → `不改动`）
  // —— 规格里加粗关键词是常态，不去掉的话「紧邻」判据永远不成立。
  // 交替剥：标记与空白/标点可能交错（`**不改动** ` 里的尾是 `** `）。
  let tail = textBefore;
  for (let i = 0; i < 4; i++) {
    const before = tail;
    tail = tail.replace(/[*_`]+$/, '').replace(/[\s:：,，、。的]*$/, '');
    tail = tail.replace(/[*_`]+$/, '');
    if (tail === before) break;
  }
  const lower = tail.toLowerCase();
  for (const phrase of phrases) {
    const p = phrase.toLowerCase().trimEnd();
    if (!p) continue;
    if (lower.endsWith(p)) return true;
  }
  return false;
}

/**
 * 找出规格里**只是被引用**（不是被要求修改）的路径。
 *
 * @param content 规格文件全文
 * @returns 只读引用的路径列表（去重，保持出现顺序）
 */
export function parseReferencedPaths(content: string): string[] {
  const referenced = new Set<string>();
  const lines = content.split('\n');

  let inReferenceSection = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      inReferenceSection = REFERENCE_SECTION.test(line);
      continue;
    }

    // A. 参考章节里的路径 —— 整段都是「拿来读的」
    if (inReferenceSection) {
      for (const { candidate } of candidatesWithIndex(line)) {
        // 参考章节也只豁免**文档**：源码出现在参考章节里，
        // 往往正是「顺便看一眼这个实现」，而不是「只读不改」。
        // 把源码也豁免 = D-4 漏报（该授权的文件被放过）。
        const p = asDocPath(candidate);
        if (p) referenced.add(p);
      }
      continue;
    }

    // B/C. 正文：指路措辞 / 只读标记后面跟着的路径
    for (const { candidate, index } of candidatesWithIndex(line)) {
      const before = line.slice(0, index);
      if (hasLeadingPhrase(before, READONLY_PHRASES)) {
        // 只读标记：不限扩展名
        const p = asAnyPath(candidate);
        if (p) referenced.add(p);
        continue;
      }
      if (hasLeadingPhrase(before, REFERENCE_PHRASES)) {
        // 指路措辞：只豁免文档
        const p = asDocPath(candidate);
        if (p) referenced.add(p);
      }
    }
  }

  return [...referenced];
}

/** 一行里的所有候选路径 + 它们在行内的位置。 */
function candidatesWithIndex(line: string): { candidate: string; index: number }[] {
  const out: { candidate: string; index: number }[] = [];
  const seen = new Set<string>();

  BACKTICKED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BACKTICKED.exec(line)) !== null) {
    const candidate = m[1].trim();
    // 命令行 / 短语不是路径（ZD-006）
    if (looksLikeCommand(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push({ candidate, index: m.index });
  }

  INLINE_PATH.lastIndex = 0;
  while ((m = INLINE_PATH.exec(line)) !== null) {
    const candidate = m[1];
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push({ candidate, index: m.index });
  }

  return out;
}
