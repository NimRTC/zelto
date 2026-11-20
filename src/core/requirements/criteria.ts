// 需求条目正文提取 —— 让切片规格拿得到「这一片要满足的那几条需求到底说了什么」
//
// ── 病灶（nimrtc v1.4 演练，2026-11-20） ──
//
// `zelto spec draft` 给模型的输入里，需求部分只有一个 **id 列表**：
//
//   # 关联需求（人已批准的出处）
//   ["N5", "N9"]
//
// 模型拿到 "N5" 这两个字，只能写通用套话 —— 实战里它写出了
// 「实现一个基本的 TURN 服务器，支持 RFC 5766 规定的核心功能」，
// 而计划里 N5 的真实内容是「**部署** coturn，一个命令拉起参考 TURN 服务器，
// 带 --require-tls 模式拒绝明文 TCP」。前者是「实现服务器」，
// 后者是「部署参考实现」—— 方向都反了。
//
// 根因在追溯链的断口：**需求条目（N5 / N2 / D3…）的正文在已确认的需求文档里，
// 但从来没有被连到切片上**。切片的 `trace.requirements` 是空的，
// 于是规格生成时既没有 id 也没有正文。
//
// 修法分两半：
//   1. 这里：从已确认的需求文档里，按 id 把需求条目的**正文**取出来
//   2. 调用方：把取到的正文放进 `SliceSpecInput`，喂给模型
//
// 为什么必须是「正文」而不是「id」：追溯链的用途是**判**，
// 判定需要知道这条需求到底要求了什么。光有 id，判定只能靠猜。
//
// C3：纯文本计算（读文件），不调模型、不触网。

/**
 * 需求条目在需求文档里的形状。
 *
 * 现实里的写法很杂：
 *   `N5 参考 TURN 部署：提供标准化TURN服务器配置模板`
 *   `- [ ] N2 ICE-over-TCP：实现RFC 6544标准的TCP穿透支持`
 *   `- [ ] D3 默认设备策略`            ← **没有冒号**
 *   `N5-1：compose 文件、服务器配置、TLS 材料生成器`
 *   `WP-12：DTX 与 3A 的契约`
 *
 * 所以：**id 是行首的那个 token**，之后是冒号（中文或英文）或空白，
 * 再往后才是正文。
 *
 * id 允许带连字符与数字（`N5-1`、`WP-12`）。
 */
const CRITERION_LINE =
  /^\s*(?:[-*+]\s*)?(?:\[[ xX]\]\s*)?([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)(?:\s*[：:]\s*|\s+)?(.*)$/;

export interface RequirementCriterion {
  /** 条目 id（如 N5、D3） */
  id: string;
  /** 条目正文 */
  text: string;
}

/**
 * 从需求文档的验收标准列表里挑出指定 id 的条目正文。
 *
 * 只认**验收标准**章节 —— 那是人批准的出处。文档里其它地方出现的同名字符串
 * （比如「功能列表」里的 `- [ ] N5 ICE-over-TCP：……」）也一并收，
 * 因为它们说的是同一件事的不同侧面，模型看见更全。
 *
 * @param spec 需求文档正文（AI 生成规格那部分）
 * @param acceptanceCriteria 需求文档的验收标准条目
 * @param ids 要找的条目 id
 */
export function extractCriteria(
  spec: string,
  acceptanceCriteria: string[],
  ids: string[],
): RequirementCriterion[] {
  const wanted = new Set(ids.map((i) => i.trim()).filter(Boolean));
  if (wanted.size === 0) return [];

  const found = new Map<string, string>();

  const take = (line: string): void => {
    const m = line.match(CRITERION_LINE);
    if (!m) return;
    const id = m[1];
    if (!wanted.has(id)) return;
    const text = m[2].trim();
    // 同一条目多处出现 → 把最长的那份留下（信息量最大的那个描述）
    const prev = found.get(id);
    if (!prev || text.length > prev.length) found.set(id, text);
  };

  for (const line of acceptanceCriteria) take(line);
  for (const line of (spec ?? '').split('\n')) take(line);

  return [...wanted].map((id) => {
    const text = found.get(id);
    return { id, text: text ?? '' };
  });
}

/**
 * 从一段文本里找出**形如需求条目 id** 的 token。
 *
 * 需求条目的 id 有固定形状：一个字母前缀（表示轨道）+ 数字
 * （`N5` = Track N 第 5 条、`D3` = Track D 第 3 条），
 * 偶尔带子编号（`N2-1`、`WP-12`）。
 *
 * 为什么需要这个：**切片与需求条目的关联没有任何自动通道**。
 * 计划里切片的标题写着「N5：examples/turn-server/ 参考 TURN 部署」，
 * 而切片的 `trace.requirements` 是空的 —— 追溯链在「需求 → 切片」
 * 这一环断了（ZD-005）。人只能手工 `zelto set --field trace.requirements`。
 *
 * 这个函数提供**候选**，判定交给人：
 * 返回的 id 必须**在已确认的需求文档里真的存在**，才允许写进 `trace.requirements`。
 * 不存在的 id 不填 —— 填了就是「追溯链上挂着一个不存在的出处」。
 *
 * @param text 待扫描的文本（切片标题 / 描述）
 * @returns 候选 id 列表（去重，保持出现顺序）
 */
export function extractCriterionIds(text: string): string[] {
  if (!text) return [];
  // 形状：一个大写字母 + 数字（+ 可选 -子编号）
  const pattern = /\b([A-Z][0-9]+(?:-[0-9]+)?)\b/g;
  const found: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    found.push(id);
  }
  return found;
}

/**
 * 需求文档里**真实存在**的条目 id 集合。
 *
 * @param spec 需求文档正文
 * @param acceptanceCriteria 需求文档的验收标准条目
 */
export function collectCriterionIds(spec: string, acceptanceCriteria: string[]): Set<string> {
  const ids = new Set<string>();
  const take = (line: string): void => {
    const m = line.match(CRITERION_LINE);
    if (m) ids.add(m[1]);
  };
  for (const line of acceptanceCriteria) take(line);
  for (const line of (spec ?? '').split('\n')) take(line);
  return ids;
}

/**
 * 把需求条目渲染成 prompt 片段。
 *
 * 找不到正文的条目**如实说找不到** —— 不编造，也不静默丢掉。
 * 找不到意味着追溯链上有洞，人需要知道。
 */
export function renderCriteriaSection(criteria: RequirementCriterion[]): string {
  if (criteria.length === 0) {
    return '（本片没有关联的需求条目 —— 规格的需求章节写「无」，验收标准需人补齐后确认）';
  }
  const lines: string[] = [];
  for (const c of criteria) {
    if (c.text) {
      lines.push(`- ${c.id}：${c.text}`);
    } else {
      lines.push(`- ${c.id}：（在需求文档里找不到该条目的正文 —— 需要人补齐，规格里不要凭空推测这一条要什么）`);
    }
  }
  return lines.join('\n');
}
