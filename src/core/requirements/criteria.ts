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
  /**
   * 这条需求在需求文档里的**其余侧面**（ZD-031）。
   *
   * 为什么需要这个字段：一条需求在文档里往往**散落在多行** ——
   * 主体描述一行、「验收：……」一行、「测试形态：……」一行、
   * 子条目（N2-1）一行。而 `text` 只能装一行（历史上装「最长那行」）。
   *
   * 实测（nimrtc v1.4 的 N2）：需求文档里有 **16 行**不同描述，
   * 包含主体、验收口径、测试形态、子条目 —— 但 `text` 只装下了**其中 1 行**
   * （「IceTransport 收集带 active/passive tcptype 的 host TCP 候选」）。
   * 验收口径（「被选中对的 protocol 读作 "tcp"」）与测试形态
   * （「环回测试里让 UDP socket 绑到互相不可路由的地址」）**全丢了**。
   *
   * 丢的可偏偏是规格里「可判定的验收标准」最需要的东西 ——
   * 模型看不到验收口径，只能自己编一条，于是又是人回去改。
   *
   * 所以这里把**去重后的全部侧面**都留着，`text` 保持向后兼容
   * （仍是主体描述），调用方（规格生成）用 `aspects` 才是完整信息。
   */
  aspects?: string[];
}

/**
 * 从需求文档的验收标准列表里挑出指定 id 的条目正文。
 *
 * 只认**验收标准**章节 —— 那是人批准的出处。文档里其它地方出现的同名字符串
 * （比如「功能列表」里的 `- [ ] N5 ICE-over-TCP：……」）也一并收，
 * 因为它们说的是同一件事的不同侧面，模型看见更全。
 *
 * ZD-031：同一条需求的**多个侧面**（主体 / 验收口径 / 测试形态 / 子条目）
 * 全部收集到 `aspects` 里，`text` 仍是最长的那一份（向后兼容）。
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
  /** 每个 id 的全部侧面（去重、保持出现顺序） */
  const aspects = new Map<string, string[]>();

  /**
   * 一个 id 是不是「被关联需求的子条目」。
   *
   * 例：wanted = {N2} 时，`N2-1` 是 N2 的子条目 —— 它的内容是 N2 的
   * 一个约束条件（而不是独立需求），必须跟着 N2 一起给模型看。
   *
   * `WP-12` 的父是 `WP` —— 只有 `WP` 本身被关联时才算子条目。
   */
  const isChildOf = (candidate: string): boolean => {
    for (const id of wanted) {
      if (candidate === id) continue;
      if (candidate.startsWith(`${id}-`)) return true;
    }
    return false;
  };

  const take = (line: string): void => {
    const m = line.match(CRITERION_LINE);
    if (!m) return;
    const id = m[1];
    const isOwn = wanted.has(id);
    const isChild = !isOwn && isChildOf(id);
    if (!isOwn && !isChild) return;
    const text = m[2].trim();
    if (!text) return;

    // 同一条目多处出现 → 把最长的那份留下（信息量最大的描述）
    if (isOwn) {
      const prev = found.get(id);
      if (!prev || text.length > prev.length) found.set(id, text);
    }

    // ZD-031：把**所有**侧面记下来（去重）。
    //
    // 去重的判据要**保守** —— 不能因为「看起来像重复」就丢掉一个侧面。
    // 真实文档里同一句话会带不同前缀重复出现（`- [ ] N2：……` 与
    // `N2：……` 是同一句），那些该去重；但「N2：主体」与
    // 「N2 验收：口径」是**不同**的侧面，必须都留。
    //
    // 归一化只剥**列表/勾选标记**（`- [ ] ` / `* ` / `- `），
    // 不动正文 —— 正文里的差异（「验收：」vs「测试形态：」）正是要留的信息。
    const normalized = normalizeAspect(text);
    const list = aspects.get(id) ?? [];
    if (!list.some((existing) => normalizeAspect(existing) === normalized)) {
      list.push(text);
      aspects.set(id, list);
    }
  };

  for (const line of acceptanceCriteria) take(line);
  for (const line of (spec ?? '').split('\n')) take(line);

  // ── 子条目并入父需求（ZD-031）──
  //
  // 需求文档里「N2-1：TCP 在 UDP 失败之后才尝试」这类**子条目**，
  // 挂在父需求 N2 下面 —— 它是 N2 的一个约束条件，**不是独立需求**。
  //
  // 为什么必须并进来：切片关联的是 `N2`，而 N2-1 的内容（「TCP 在 UDP
  // 失败之后才尝试，不是和 UDP 赛跑」）是 N2 里**最容易漏实现**的一条
  // —— 它是一条「负向」纪律，模型看不到就一定会实现错
  // （先并行尝试 TCP 与 UDP 再看谁先通）。
  //
  // 子条目在 `take` 里已经按 `isChildOf` 收进 `aspects`（挂在**它自己**的
  // id 下），这里只要把子条目的侧面搬到父需求名下。
  //
  // 注意 `N2-1` 自己也可能被**直接**关联（人写 `trace.requirements = ["N2-1"]`），
  // 那时它作为独立需求出现在结果里 —— 两种情况不冲突。
  return [...wanted].map((id) => {
    const ownText = found.get(id);
    const all = [...(aspects.get(id) ?? [])];
    // 把子条目（N2-1）的侧面搬进父需求（N2）
    for (const [candidateId, list] of aspects) {
      if (candidateId === id) continue;
      if (!candidateId.startsWith(`${id}-`)) continue;
      for (const childText of list) {
        if (!all.includes(childText)) all.push(childText);
      }
    }

    // ZD-031：**父需求自己没有正文、但有子条目**时，主体取第一个侧面。
    //
    // 病灶：需求文档里只写了「N2-1：TCP 在 UDP 失败之后才尝试」而没写
    // 「N2：……」—— 这时 `found` 里没有 N2，正文是空串。
    // 而「找不到正文」在下游的语义是「**追溯链上有洞，人得去补**」
    // （`renderRequirementDetails` 会如实写「找不到这一条的正文」）。
    // 明明有子条目内容却说「找不到」= 假报 —— 人又要去查一遍。
    const text = ownText ?? all[0] ?? '';

    return {
      id,
      text,
      // 只有一个侧面时不必给 aspects —— 调用方按数组长度判断即可。
      // 但「自己没正文、内容全来自子条目」时要给 —— 否则下游看不出
      // 「这条其实有内容，只是来自子条目」。
      aspects: all.length > 1 || (!ownText && all.length === 1) ? all : undefined,
    };
  });
}

/**
 * 归一化需求侧面的文本，用于**去重**（不是用于输出）。
 *
 * 只剥列表 / 勾选标记与 markdown 强调标记 ——
 * `- [ ] N2：主体` 与 `N2：主体` 归一化成同一串；
 * `**TCP 在 UDP 失败之后才尝试**` 与 `TCP 在 UDP 失败之后才尝试` 也是同一句。
 *
 * 为什么不剥更多：`N2：主体` 与 `N2 验收：口径` 只差「验收：」三个字，
 * 而那正是**必须区分**的信息。剥多了就把不同的侧面合并成一个，
 * 回到「一条需求只给一行」的老问题。
 *
 * 引号统一成直引号 —— 真实文档里同一句话会用不同的引号（`「」` 与 `“”`），
 * 那是排版差异，不是内容差异。
 */
function normalizeAspect(text: string): string {
  return text
    .trim()
    .replace(/^[-*+]\s*/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/[「」“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
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
 *
 * ZD-031：一条需求有多个侧面时**全部列出** —— 只列主体会让模型漏掉
 * 验收口径与测试形态（那正是规格里「可判定的验收标准」最需要的）。
 */
export function renderCriteriaSection(criteria: RequirementCriterion[]): string {
  if (criteria.length === 0) {
    return '（本片没有关联的需求条目 —— 规格的需求章节写「无」，验收标准需人补齐后确认）';
  }
  const lines: string[] = [];
  for (const c of criteria) {
    if (c.aspects && c.aspects.length > 0) {
      // 多个侧面：主体一行，其余侧面逐条列出
      const [first, ...rest] = c.aspects;
      lines.push(`- ${c.id}：${first}`);
      for (const aspect of rest) {
        lines.push(`  - ${aspect}`);
      }
    } else if (c.text) {
      lines.push(`- ${c.id}：${c.text}`);
    } else {
      lines.push(`- ${c.id}：（在需求文档里找不到该条目的正文 —— 需要人补齐，规格里不要凭空推测这一条要什么）`);
    }
  }
  return lines.join('\n');
}
