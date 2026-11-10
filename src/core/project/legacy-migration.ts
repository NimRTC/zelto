// 老版本 zelto 生成物的识别与迁移
//
// 背景（ADR-040 §2）：
// ADR-038 给 zelto 自己生成的文件加了一行 `# zelto:generated:<hash>` 标记，
// 接管时靠「哈希比对」判断「这份文件还是不是 zelto 留下的原样」——
// 一致就可以按真实探测结果重建，不一致就一个字都不动。
//
// 但**标记行是 ADR-038 之后才有的**。更早的 zelto 生成的文件没有这一行，
// 于是判定一律落到「人手写的」：
//
//   - 门禁命令还是通用的 `pnpm test`（在 CMake / Rust 项目上是错的）；
//   - 写集规则没按实际模块生成；
//   - 根级构建清单没有规则（规格里明写「在顶层 CMakeLists.txt 注册新模块」
//     就会被 PreToolUse 钩子当场拒掉）。
//
// 也就是说：ADR-038 / ADR-039 的接管改进，对所有 **ADR-038 之前**接管的
// 既有项目**完全失效** —— 看起来「接管成功了」，其实什么都没接管。
//
// 本模块给出第三态：`legacy`（老版本 zelto 生成的，但没法证明人没动过）。
// 识别靠**内容特征**（生成器的文件头 + `# Auto-generated for` 行），
// 不靠标记行 —— 标记行正是老文件没有的东西。
//
// C3：纯文件判定 + 纯计算，不调模型、不触网。

import { parsePolicyYaml } from '../policy/yaml.js';
import type { PolicyRule } from '../policy/types.js';

/** 托管文件的来源判定 */
export type ManagedSource =
  /** 当前版本 zelto 生成，且内容哈希与标记一致（可安全重建） */
  | 'generated'
  /** 老版本 zelto 生成的（无标记行，靠内容特征识别） */
  | 'legacy'
  /** 人手写的 —— 一个字都不动 */
  | 'manual';

/** 老版本生成器的文件头特征 */
const LEGACY_POLICY_HEADER = '# zelto policy rules';
const LEGACY_CONFIG_HEADER = '# zelto project configuration';

/** 老版本生成器写的第二行特征 */
const LEGACY_AUTO_GENERATED = '# Auto-generated for';

/**
 * 当前版本生成器的标记行前缀（与 initializer.ts 的口径一致）。
 *
 * **必须有这一档**：新生成器写出的文件同样有「文件头 + Auto-generated」两行
 * —— 内容特征本身区分不了新旧。唯一的区分是**标记行**：
 *
 *   - 有标记行 → 当前版本生成的（哪怕人后来改过）→ 一律按「人手写的」处置；
 *   - 无标记行 → 只能是 ADR-038 之前的老生成器写的 → 才有资格谈「能不能重建」。
 *
 * 少了这一档，一个**被人改过的当前版本策略**会被当成 legacy，
 * 若它的人工规则恰好都包含在新生成物里，就会被覆盖 —— 那是在毁掉人的规则。
 */
const GENERATED_MARKER_PREFIX = '# zelto:generated:';

/** 这份内容里有没有当前版本的生成标记行？ */
export function hasGeneratedMarker(content: string): boolean {
  return content.split('\n').some((l) => l.trimStart().startsWith(GENERATED_MARKER_PREFIX));
}

/**
 * 这份内容是老版本 zelto 生成的吗？
 *
 * 判据是**内容特征**而不是标记行：
 *   - 文件头一行是老生成器的固定标题；
 *   - 有一行 `# Auto-generated for "<项目名>"`；
 *   - **且没有当前版本的生成标记行**（有标记行的是当前版本的文件，不算 legacy）。
 *
 * 两条都满足才算 —— 只满足一条的话，人手写的文件只要抄了标题就会被误判成
 * 可重建的生成物（那会覆盖掉人的规则）。
 */
function looksLegacyGenerated(content: string, header: string): boolean {
  if (hasGeneratedMarker(content)) return false;
  const lines = content.split('\n');
  const hasHeader = lines.some((l) => l.trim() === header);
  const hasAutoLine = lines.some((l) => l.trimStart().startsWith(LEGACY_AUTO_GENERATED));
  return hasHeader && hasAutoLine;
}

/** 老版本的 `policy.yaml`？（只认内容特征，不看有没有标记行） */
export function isLegacyPolicyContent(content: string): boolean {
  return looksLegacyGenerated(content, LEGACY_POLICY_HEADER);
}

/** 老版本的 `.zelto/config.yaml`？ */
export function isLegacyConfigContent(content: string): boolean {
  return looksLegacyGenerated(content, LEGACY_CONFIG_HEADER);
}

/**
 * 规则的比较键：`路径 | 操作 | 动作`。
 *
 * 只比这三样：规则 id 与 basis 在新旧生成器之间会变（id 带序号，
 * basis 指向 id），拿它们比会把「同一份策略的新旧两版」判成不同。
 */
function ruleKey(r: PolicyRule): string {
  return `${r.match?.path ?? ''}|${r.match?.operation ?? ''}|${r.action ?? ''}`;
}

/** 一份策略里所有规则的比较键集合 */
export function ruleKeys(content: string): Set<string> {
  const parsed = parsePolicyYaml(content);
  return new Set(parsed.rules.map(ruleKey));
}

/**
 * 老策略能不能被新生成物**安全替换**？
 *
 * 判据：老策略里的每一条规则，在新生成物里都能找到**同样的**（路径, 操作, 动作）。
 *
 * 为什么用这个判据：
 *   - 老策略的规则都是老生成器按「顶层目录」发的，没有根级构建清单规则 ——
 *     所以「老 ⊆ 新」天然成立（除非人加过规则）；
 *   - 人加过的规则（自定义 deny、ask、放行某个目录）不在新生成物里 ——
 *     判据不成立 → 这份文件当人写的处理，一个字都不动。
 *
 * 这样「能安全重建」与「不能安全重建」的界线是**可判定的**，
 * 不靠「看起来像不像人改的」。
 */
export function legacyPolicyIsRebuildable(legacyContent: string, newContent: string): boolean {
  const legacy = ruleKeys(legacyContent);
  const next = ruleKeys(newContent);
  for (const key of legacy) {
    if (!next.has(key)) return false;
  }
  return true;
}

/**
 * 老配置能不能被新生成物**安全替换**？
 *
 * 判据：门禁命令仍然是**通用默认值**（`pnpm test` / `pnpm lint` / 空）。
 *
 * 为什么只认这一种：
 *   - 老生成器对非 C++ 项目发的就是 `pnpm test` / `pnpm lint` ——
 *     在 C++ / Rust 项目上这是错的命令，必须换成探测结果；
 *   - 只要门禁命令是人自定义的（多行 YAML、cmake 参数、ctest 过滤…），
 *     就分不清「人写的」还是「老生成器按 C++ 探测出来的」——
 *     宁可不动，让人自己核对，也不替人改门禁命令。
 */
export function legacyConfigIsRebuildable(content: string): boolean {
  const runs = [...content.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) =>
    m[1].trim().replace(/^["']|["']$/g, ''),
  );
  if (runs.length === 0) return true; // 没有门禁命令 = 等同默认
  return runs.every((r) => r === '' || r === 'pnpm test' || r === 'pnpm lint');
}

/**
 * 老策略里 `anchors:` 段记的锚点哈希。
 *
 * 老版本的锚点写在策略自己体内（ADR-039 已把它外部化到 `policy/lock.json`），
 * 形如：
 *
 * ```yaml
 * anchors:
 *   policy: "sha256:...."
 * ```
 *
 * 取出来是为了**不丢锚点**：策略被人改过而老锚点没动，是一件可检出的事；
 * 迁移时把这个锚点搬进 `policy/lock.json`，失配就能被 `policy lock` 判出来。
 */
export function extractLegacyAnchor(content: string): string | null {
  const lines = content.split('\n');
  let inAnchors = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inAnchors) {
      if (trimmed === 'anchors:') inAnchors = true;
      continue;
    }
    // anchors 段里的条目形如 `policy: "sha256:xxxx"`
    const m = trimmed.match(/^policy:\s*["']?(sha256:[0-9a-fA-F]{64})["']?$/);
    if (m) return m[1];
  }
  return null;
}
