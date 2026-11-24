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
 * 「只读作用域」的**边界字符** —— 遇到它，只读标记就不再往后绑定了。
 *
 * 为什么是句号而不是逗号（ADR-098 决策一 + 实现要点 1）：
 *
 *   「只读 `a.cpp`，`b.cpp`」  → 两个**都**是只读（逗号只是并列连接）
 *   「只读 `a.cpp`。但要改 `b.cpp`」 → 只有 `a.cpp` 是只读
 *
 * 逗号是**并列**的连接符（人写「只读 A、B」就是两个都只读），
 * 句号才是**句子的**分界（句号后面是新的一句话，新句子里的话不再受
 * 前面那个「只读」管辖）。
 *
 * 分号同理 —— 「只读 `a.cpp`；`b.cpp` 照它的样子写」里 `b.cpp`
 * 其实是**要照着写**的（是参照物，也是只读），但「只读 `a.cpp`；
 * 要改 `b.cpp`」里 `b.cpp` 是要改的 —— 分号两侧语义不定，
 * 所以**不把分号当边界**（宁可漏认，让它走「紧邻」判据）。
 */
const SCOPE_BOUNDARY = /[。！？]/;

/**
 * 「只读作用域」的**反转措辞** —— 遇到它，只读作用域就**结束**。
 *
 * 为什么需要它（ZD-034 回归实测）：
 *
 *   「只读 `ice.c`，**但要改** `udp_socket.cpp`」
 *
 *   这句里 `udp_socket.cpp` 是**要改的** —— 人用「但要改」明确反转了
 *   「只读」的适用范围。如果没有反转判据，「只读」作用域会一路延伸到
 *   句末 → `udp_socket.cpp` 被豁免 → **D-4 漏报**
 *   （真正要改、却没被写集授权的文件被放过，agent 撞写集守卫时才炸）。
 *
 *   漏报比误报更糟（AGENTS.md），所以这条必须有。
 *
 * 措辞清单分两组：
 *   - 明确反转：「要改」「要修改」「需要改」「将要改」「改为」「修改为」
 *   - 引入新话题的连接词：「但」「但是」「然而」「不过」「而」
 *
 * 英文：'but', 'however', 'instead', 'to modify', 'must change'。
 *
 * **为什么「但 / 而」这类连接词也算反转**：
 *   「只读 `a.cpp`，**但** `b.cpp` 是要改的」—— 人用「但」起头新分句，
 *   语义上已经离开了「只读」的管辖范围。保守起见**宁可多认反转**
 *   （多认 = 漏豁免 = 报出来让人补一句「只读」，代价是几分钟；
 *   少认 = 漏报 = agent 撞守卫，代价是几小时）。
 */
const SCOPE_RESET = /但要改|但需改|但需要改|要修改|需要修改|需要改|要改|将要改|改为|修改为|但|但是|然而|不过|而是|但要|\bbut\b|\bhowever\b|\binstead\b/i;

/**
 * 一行里的某个位置之前，**同一个列表条目内**有没有只读标记。
 *
 * 「同一个列表条目」的含义：从行首（或上一个列表符号）到当前位置之间。
 * 列表项之间的只读标记**不互相传染** ——
 * `- 只读 \`a.cpp\`` 这一项的只读，不该影响下一项 `- \`b.cpp\``。
 *
 * 为什么要「条目内」而不是「行内」：
 *   规格的「范围」章节常写成一行多个列表项（表格化写法）：
 *   `- 只读 \`a.cpp\` —— 说明     - \`b.cpp\` —— 要改的`
 *   行内判据会把 `b.cpp` 也豁免 → 真正要改的文件被放过 → D-4 漏报。
 *
 * @param line 整行
 * @param index 候选路径在行内的起始位置
 */
function hasReadonlyScopeInItem(line: string, index: number): boolean {
  const before = line.slice(0, index);

  // 只看**当前列表条目**的部分：截到上一个列表符号（`-` / `*` / `数字.`）之前。
  const itemStart = findItemStart(before);
  const scoped = before.slice(itemStart);

  // 条目内出现句号 → 只读作用域到此为止
  if (SCOPE_BOUNDARY.test(scoped)) return false;

  // 条目内出现反转措辞 → 只读作用域到此为止（ZD-034）
  //
  // 取**最后**一次反转措辞的位置：只读标记必须在反转措辞**之后**才生效。
  // 「但要改 `b.cpp`，只读 `a.cpp`」—— 只读标记在反转之后 → 生效。
  const resetMatch = lastResetIndex(scoped);
  if (resetMatch >= 0) {
    const afterReset = scoped.slice(resetMatch);
    // 反转措辞之后还有只读标记 → 作用域重新开始
    if (!mentionsReadonlyPhrase(afterReset)) return false;
  }

  // 条目内有没有只读标记（不限扩展名，语义更强）
  return mentionsReadonlyPhrase(scoped);
}

/**
 * 找最后一个反转措辞的位置（-1 = 没有）。
 *
 * 为什么要「最后一个」而不是「第一个」：
 *   「只读 `a.cpp`，但 `b.cpp` 要改，只读 `c.cpp`」
 *   —— 作用域在「但」处结束，在第二个「只读」处重新开始。
 *   取「第一个」会把第二个「只读」也吃掉 → `c.cpp` 被当只读（这倒对）
 *   但更重要的是取「最后一个」能让「但」之后的普通路径（如 `b.cpp`）不被豁免。
 */
function lastResetIndex(text: string): number {
  let last = -1;
  const re = new RegExp(SCOPE_RESET.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m.index;
  }
  return last;
}

/**
 * 找出「当前列表条目」的起点。
 *
 * 判据：往前找最近的列表符号（`- ` / `* ` / `+ ` / `1. `）。
 * 找不到就用行首。
 */
function findItemStart(textBefore: string): number {
  const listItem = /(?:^|\s)(?:[-*+]\s+|\d+[.)]\s+)/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = listItem.exec(textBefore)) !== null) {
    last = m.index;
  }
  return last === -1 ? 0 : last + 1;
}

/**
 * 一段文字里有没有只读标记。
 *
 * 与 `hasLeadingPhrase` 的区别：那个判「**紧邻**」（标记必须贴着路径），
 * 这个判「**这一段里出现过**」—— 用于只读作用域的延续判定。
 *
 * 标记本身不需要紧贴任何东西，所以只需要**出现过**。
 */
function mentionsReadonlyPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  for (const phrase of READONLY_PHRASES) {
    const p = phrase.toLowerCase().trimEnd();
    if (!p) continue;
    if (lower.includes(p)) return true;
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
      for (const { candidate, index } of candidatesWithIndex(line)) {
        // 参考章节也只豁免**文档**：源码出现在参考章节里，
        // 往往正是「顺便看一眼这个实现」，而不是「只读不改」。
        // 把源码也豁免 = D-4 漏报（该授权的文件被放过）。
        //
        // ZD-034：但**条目级「只读」前缀**优先于章节规则 ——
        // 「- 只读 \`src/x/ice.c\`」在参考章节里也是**明确不许改**的，
        // 而章节规则只豁免文档 → 源码被漏豁免 → D-4 误报。
        // 显式的只读标记语义比章节的默认语义强。
        //
        // 注意：这里**不**查只读作用域（跨路径延续）——
        // 参考章节里的源码要豁免，得靠**紧邻**的只读标记
        // （`- 只读 \`src/x/ice.c\`` —— 路径就是紧挨着标记的那个）。
        // 作用域延续留给正文通道处理。
        const before = line.slice(0, index);
        if (hasLeadingPhrase(before, READONLY_PHRASES)) {
          const p = asAnyPath(candidate);
          if (p) referenced.add(p);
          continue;
        }
        const p = asDocPath(candidate);
        if (p) referenced.add(p);
      }
      continue;
    }

    // B/C. 正文：指路措辞 / 只读标记后面跟着的路径
    for (const { candidate, index } of candidatesWithIndex(line)) {
      const before = line.slice(0, index);

      // 只读作用域内（同一列表条目内、句号之前）→ 整条都只读。
      //
      // ZD-034：原先只认「紧邻」的只读标记，于是
      // 「只读 \`a.cpp\` 与 \`b.cpp\`」只豁免了 `a.cpp` ——
      // 而人写这句话时，`b.cpp` 同样是**只读参考**。
      // 漏豁免 = D-4 误报 = 人回去改写集 = 几小时的往返（ADR-098 实测）。
      if (hasReadonlyScopeInItem(line, index)) {
        const p = asAnyPath(candidate);
        if (p) referenced.add(p);
        continue;
      }

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
