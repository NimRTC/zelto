// 占位符标题识别 —— 提示词模板里的填空槽不该被当成真标题
//
// 实测缺陷 D-3：需求 / 设计 / 计划的标题永久停在占位符「需求标题」，
// 追溯链上全是占位符 —— 看起来像内容没生成，其实是标题没被识别出来。
//
// 根因：提示词模板里写的是 `# 需求标题` / `# 设计标题`，模型有时会
// **原样照抄**模板的结构与文字。于是解析器把占位符当成了标题。
//
// 现在提示词里的占位符写成 `<需求标题>`（角括号形式）—— 明确是填空槽。
// 但模型仍可能照抄，所以解析侧还要判一次。

/**
 * 占位符标题集合。
 *
 * 包含历史格式（不带尖括号）与当前格式（带尖括号），
 * 以及各生成器的默认回退串。
 */
const PLACEHOLDER_TITLES = new Set([
  // 历史格式：提示词模板里原本就是这几个字
  '需求标题',
  '设计标题',
  '项目标题',
  '标题',
  // 当前格式：尖括号填空槽
  '<需求标题>',
  '<设计标题>',
  '<项目标题>',
  '<标题>',
  // 各生成器的默认回退串
  'Untitled Requirement',
  'Untitled Design',
  'Untitled',
]);

/**
 * 标题是不是占位符。
 *
 * 判据：
 * - 去空白后与占位符集合精确相等
 * - 或以 `<` 开头且以 `>` 结尾（形如 `<xxx>` 的填空槽）
 * - 或整串由角括号包裹（`〈需求标题〉`、`《需求标题》` 等中文括号）
 */
export function isPlaceholderTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (PLACEHOLDER_TITLES.has(t)) return true;
  if (/^<.+>$/.test(t)) return true;
  if (/^[〈《【].+[〉》】]$/.test(t)) return true;
  return false;
}

/**
 * 从正文里捞一句像标题的话 —— 占位符标题时的兜底。
 *
 * 判据：首个非空、非标题符号、非列表项、长度不超过 60 的行。
 */
export function fallbackTitleFrom(content: string): string | null {
  const candidate = content
    .split('\n')
    .map((l) => l.trim())
    .find(
      (l) =>
        l.length > 0 &&
        !l.startsWith('#') &&
        !l.startsWith('-') &&
        !l.startsWith('>') &&
        !l.startsWith('*') &&
        l.length <= 60,
    );
  return candidate ?? null;
}
