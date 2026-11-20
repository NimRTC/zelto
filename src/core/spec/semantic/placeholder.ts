// 占位符识别 —— 「规格里是不是真留了没写的坑」
//
// 为什么要有这个模块（ZD-019）：
//
//   原来的判据是一条全文正则：
//
//     /TBD|TODO|FIXME|coming soon|not yet determined|to be filled/i
//
//   它把**任何**出现这些词的地方都当成「规格里留了占位符」。
//   而规格里提到一个 **API 名** 是家常便饭 ——
//   「验收测试文件里不许残留 `test.todo`」这句话本身是对 agent 的约束，
//   但 `test.todo` 里的 `todo` 正好命中那条正则 → 误报。
//
//   闸门误报比闸门漏报更糟（AGENTS.md 明确写了这条）：误报让人以为
//   「规格有问题」，于是去**改正确的规格** —— 把一条精确的约束写模糊；
//   或者干脆去改工具，把真占位符一起放过。
//
// 所以判据不能是「文本里出现了这个词」，而要是
// **「这个词出现在占位符该出现的位置」**。

/**
 * 占位符词表 —— 单词本身。
 *
 * 为什么是单词而不是正则片段：「coming soon」「not yet determined」
 * 是短语，单词表放不下；它们在下面 `PHRASE_PLACEHOLDERS` 里单列。
 */
const PLACEHOLDER_WORDS = ['TBD', 'TODO', 'FIXME', 'XXX'] as const;

/**
 * 占位符短语 —— 需要整段匹配的多词形态。
 *
 * 「not yet」单独列出来的原因：`not yet determined` / `not yet implemented`
 * 是同一类意思，而「not yet」本身（英文口语「还没」）在中文规格里偶尔出现，
 * 单独列会误报得更多。
 */
const PHRASE_PLACEHOLDERS = [
  'coming soon',
  'not yet determined',
  'not yet implemented',
  'not yet known',
  'to be filled',
  'to be determined',
  'to be implemented',
] as const;

/**
 * 中文占位语义词 —— 「待定 / 待补 / 暂缺 / 未定 / 后补」。
 *
 * 这些词**必须**跟一个路径或标识符一起出现才算占位符
 * （「待定」也可能只是普通叙述：「这个值待定由上层决定」）。
 * 单独出现不算。
 */
const CN_PLACEHOLDER_HINTS = ['待定', '待补', '暂缺', '未定', '后补', '待确认'] as const;

/**
 * 一个词是不是**标识符的一部分**。
 *
 * 判据：词的**前后**紧邻的字符是「标识符字符」
 * （字母 / 数字 / `_` / `.` / `-` / `/`）。
 *
 * 为什么需要这条：
 *   - `test.todo` → `todo` 前面是 `.` → 是 API 名的一部分 → 不算占位符
 *   - `createTodo` → 后面是 `e` → 标识符的一部分 → 不算占位符
 *   - `TODO_LIST` → 后面是 `_` → 标识符的一部分 → 不算占位符
 *   - `TODO`（独立） → 前后都不是标识符字符 → 算占位符
 *   - `TODO：实现细节` → 后面是中文冒号 → 不算标识符字符 → 算占位符
 *
 * 注意 `:` **不在**标识符字符集里 ——
 * 「TODO: 还没想清楚」是占位符的典型形态（标记 + 连接词 + 内容），
 * 而命名空间前缀（`ns:TODO`）在规格里不现实。
 */
function isIdentifierPart(ch: string | undefined): boolean {
    if (!ch) return false;
  return /[A-Za-z0-9_.\-/]/.test(ch);
}

/**
 * 一行里是不是「占位符作为一个独立的东西出现」。
 *
 * 判据：
 *   1. 占位符词**独立**（前后都不是标识符字符）；
 *   2. 行首就是它（允许前导的 markdown 列表符号与空白）；
 *   3. 或者它后面紧跟「占位语义」的连接词（`:`、`：`、`-`、`—`、
 *      `待补`、`待确认` …）—— 这是「留了个坑」的典型形态。
 */
function lineHasPlaceholderToken(line: string): boolean {
    for (const word of PLACEHOLDER_WORDS) {
        // 大小写不敏感地找每一处出现
        const re = new RegExp(`\\b${word}\\b`, 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
            const before = m.index > 0 ? line[m.index - 1] : undefined;
            const after = line[m.index + word.length];
            if (isIdentifierPart(before) || isIdentifierPart(after)) continue;

            // 独立出现 → 看它是不是「占位语义」的用法
            const head = line.slice(0, m.index).replace(/^[\s>*\-#]+/, '').trim();
            const tail = line.slice(m.index + word.length).trim();

            // 前文已经把它说成「占位」了 —— 「TODO: 待补」「待定：TBD」
            if (head.endsWith('待定') || head.endsWith('待补') || head.endsWith('待确认')) return true;

            // 后面跟着连接词 → 「TODO: …」「TODO - …」
            if (/^[:：\-—–(（]/.test(tail)) return true;

            // 整行就是它（或只有 markdown 装饰 + 它）→ 明确的占位
            if (head === '' && tail === '') return true;

            // 后面跟中文/英文说明文字 → 「TODO 实现细节」
            if (tail.length > 0 && !/^[\s`*_\]})]/.test(tail)) return true;
        }
    }
    return false;
}

/**
 * 一行里是不是「占位符短语」。
 *
 * 短语形态多（「not yet determined」），必须按**整体出现**判定，
 * 而不是拆成单词逐个查（拆了就会把「not yet」这种普通说法也抓进来）。
 *
 * 边界判据：短语的前后不能是标识符字符
 * （「not yet determined-ness」不算、「not yet determined」算）。
 */
function lineIsPlaceholderPhrase(line: string): boolean {
  const lower = line.toLowerCase();
  for (const phrase of PHRASE_PLACEHOLDERS) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(phrase, from);
      if (idx === -1) break;
      const before = idx > 0 ? line[idx - 1] : undefined;
      const after = line[idx + phrase.length];
      if (!isIdentifierPart(before) && !isIdentifierPart(after)) return true;
      from = idx + phrase.length;
    }
  }
  return false;
}

/**
 * 一行里是不是「中文占位语义 + 一个具体的东西」。
 *
 * 例：「待定：`src/foo.cpp`」「待补：具体的错误处理策略」
 *
 * 判据：出现中文占位提示词，且它后面**确实跟了一个具体的东西**
 * —— 具体 = 连接词（`:`/`：`）之后的内容，或是紧跟的路径/标识符。
 *
 * 为什么不能「后面有字就算」：
 *   「这个值待定由上层决定」是**普通叙述**，不是留坑。
 *   把普通叙述也报成占位符 = 误报（AGENTS.md：误报比漏报更糟）。
 */
function lineHasChinesePlaceholder(line: string): boolean {
  for (const hint of CN_PLACEHOLDER_HINTS) {
    const idx = line.indexOf(hint);
    if (idx === -1) continue;
    const before = idx > 0 ? line[idx - 1] : undefined;
    const after = line[idx + hint.length];
    if (isIdentifierPart(before) || isIdentifierPart(after)) continue;

    const tail = line.slice(idx + hint.length).trim();
    if (!tail) continue;

    // 形态一：连接词开头的具体内容 —— 「待定：xxx」
    if (/^[:：]/.test(tail)) return true;

    // 形态二：紧跟路径/标识符 —— 「待定 src/foo.cpp」
    // 路径特征：含 `/` 且有扩展名；标识符特征：反引号包裹
    if (/^`[^`]+`/.test(tail)) return true;
    if (/^[\w.-]+\/[\w./-]+\.[A-Za-z0-9]{1,6}/.test(tail)) return true;

    // 形态三：整行就是这个词（加 markdown 装饰）—— 「待定」
    const head = line.slice(0, idx).replace(/^[\s>*\-#]+/, '').trim();
    if (!head && !tail) return true;
  }
  return false;
}

/**
 * 规格里有哪些占位符。
 *
 * @param specContent 规格全文
 * @returns 命中的占位符所在行（去重，保持出现顺序）
 */
export function findPlaceholders(specContent: string): string[] {
    const hits: string[] = [];
    const seen = new Set<string>();

    for (const line of specContent.split('\n')) {
        const isHit =
            lineHasPlaceholderToken(line) ||
            lineIsPlaceholderPhrase(line) ||
            lineHasChinesePlaceholder(line);
        if (!isHit) continue;
        const key = line.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hits.push(key);
    }

    return hits;
}

/**
 * 规格里是不是真留了占位符。
 *
 * @param specContent 规格全文
 */
export function hasPlaceholder(specContent: string): boolean {
    return findPlaceholders(specContent).length > 0;
}
