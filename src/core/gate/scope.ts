// 门禁**作用域** —— 按切片的写集收窄「构建什么、跑哪些用例」
// See docs/adr-097-gate-scope-by-write-set.md
//
// ── 为什么要它（nimrtc-v14 实测）──────────────────────────────────────────
//
// `v2-ice` 一片只碰了 ice 与 sdp 两个模块，却要跑**全部 2387 个用例** ——
// 其中 audio、video、webrtc、dtls 的用例一个都没被这次改动影响。
// ZD-028 量化过：门禁墙钟 4494s，`test` 命令占 4055s（90%）。
//
// 代价不只是时间，是**信号被稀释**：2337 个用例的通过记录里，
// agent 找不到「哪个用例跟我有关」；而且门禁跑全量会制造一个危险的
// 错觉 —— 「门禁过了 = 整个项目都好了」。收窄后这个错觉消失，
// 门禁过了意味着「我这片的改动是好的」，这才是我们要的。
//
// ── 这个模块做什么 ────────────────────────────────────────────────────────
//
// 1. 解析 `gate.scope` 段的规则（写集路径模式 → 作用域标签）；
// 2. 把切片的**写集**按规则匹配成**标签集合**；
// 3. 从 `ctest --show-only=json-v1` 的输出里，精确筛出带这些标签的
//    **用例名清单**（清单文件供 `--tests-from-file` 用）。
//
// ── 为什么不调模型、不读文件以外的东西（C3）──────────────────────────────
//
// 纯字符串 / 纯 JSON 计算：同样的输入永远得到同样的结果。判定可复现。
// 本模块在 core/ 内，不依赖 adapters/、不发网络请求（C2 / C6）。
//
// ── 关键安全约束（ADR-097 决策三 / 决策四）──────────────────────────────
//
// **标签匹配不到用例时必须退回全量，不许跑 0 个用例。**
// 因为 ctest 在「没匹配到用例」时退出码是 **0**（ADR-096 已实测：
// `No tests were found!!!`）—— 那就是**门禁假绿**，最危险的失败模式。
// 「抽不出」永远不等于「没有」。

import { ctestInsertPoint, sanitizeForFilename } from './diagnostics.js';

/**
 * 一条作用域规则。
 *
 * `match` 是**写集路径模式**（与 policy 的 glob 语义同源），
 * `labels` 是这条模式命中后要收窄到的**作用域标签**。
 */
export interface ScopeRule {
  /** 写集路径模式（glob）。 */
  match: string;
  /** 作用域标签（CTest LABELS）。 */
  labels: string[];
}

/**
 * 作用域配置。
 *
 * `fallback` 目前只有 `full` 一个取值 —— 「一条写集都没命中规则时，
 * 跑全量」。
 *
 * **为什么没有 `none`**（ADR-097 决策四）：`none` 等于「门禁可以
 * 什么都不验就通过」，与 C3/C7 的追溯精神直接冲突。不提供这个选项，
 * 就不存在「手滑配出一个假绿门禁」的可能。
 */
export interface ScopeConfig {
  rules: ScopeRule[];
  /** 写集没命中任何规则时的兜底。缺省 = `full`（跑全量）。 */
  fallback: 'full';
}

/**
 * 作用域解析的结果 —— 说清「这轮为什么收窄 / 为什么没收窄」。
 *
 * `source` 是**给人看的**（也是事件里留痕的）三个来源：
 * - `config`：配了规则，且写集命中了规则 → 收窄；
 * - `fallback-full`：配了规则，但写集**没命中**任何规则 → 退回全量；
 * - `no-config`：压根没配 `gate.scope` → 全量（老行为）。
 */
export type ScopeSource = 'config' | 'fallback-full' | 'no-config';

/** 作用域匹配的结果。 */
export interface ScopeMatch {
  /** 命中的标签（去重、保序）。`source === 'config'` 时非空。 */
  labels: string[];
  /** 为什么是这个结果。 */
  source: ScopeSource;
  /** 人话说明 —— 直接给人看，也可进事件。 */
  reason: string;
  /** 命中的规则（去重后的 match 模式列表）。用于留痕与排查。 */
  matchedPatterns: string[];
}

// ─── 规则解析 ───────────────────────────────────────────────────────────────

/**
 * 解析 `gate.scope` 段的**内容块**（不含 `scope:` 这一行本身）。
 *
 * 调用方（`core/config/loader.ts`）负责把 `scope:` 下面的行抠出来传进来 ——
 * 因为 `scope:` 是**嵌套在 `gate:` 下面**的，config 解析器已经有一套
 * 「按缩进跟踪段落」的状态机，在这里再写一份顶层段落解析器就是
 * **两份漂移的解析逻辑**（那正是 ADR-049 要消除的东西）。
 *
 * 内容块的形态（每行都相对 `scope:` 缩进）：
 *
 * ```yaml
 * rules:
 *   - match: "src/modules/ice/**"
 *     labels: ["ice"]
 *   - match: "src/modules/sdp/**"
 *     labels: ["sdp"]
 * fallback: full
 * ```
 *
 * `labels` 也接受逗号分隔的裸值（`labels: ice, sdp`）——
 * 与 ADR-051 的 `spec.gateCommands` 只吃 JSON 不同，这里刻意放宽：
 * 标签是**短词**、不含逗号/引号，用逗号分隔不会切错；
 * 而 JSON 形式也照收（`labels: ["ice"]`）。
 *
 * 解析不到任何规则 → 返回 null（= 没配作用域 → 全量，老行为）。
 *
 * C3：纯解析，不调模型、不触网。
 */
export function parseScopeConfig(block: string): ScopeConfig | null {
  const rules: ScopeRule[] = [];
  let fallback: 'full' = 'full';

  const lines = block.split('\n');
  let inRules = false;
  /** 当前正在攒的规则。 */
  let current: { match: string; labels: string[] } | null = null;
  let currentIndent = 0;

  const flush = (): void => {
    if (current && current.match && current.labels.length > 0) {
      rules.push({ match: current.match, labels: current.labels });
    }
    current = null;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    const indent = raw.length - trimmed.length;
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed === 'rules:') {
      flush();
      inRules = true;
      continue;
    }

    if (trimmed.startsWith('fallback:')) {
      flush();
      const raw2 = trimmed.slice(9).trim().toLowerCase();
      // 只认 `full` —— 其它值**不猜**：静默当 full 会掩盖配置错误，
      // 而静默当 none 就是假绿门禁。
      if (raw2 && raw2 !== 'full') {
        throw new Error(
          `gate.scope.fallback 只认识 "full"（收到 "${raw2}"）。` +
          `不认识的取值一律不猜 —— 静默按 full 处理会掩盖配置错误。`,
        );
      }
      continue;
    }

    if (!inRules) continue;

    // 规则项：`- match: "xxx"` 或 `- match: xxx`（行内）
    const inlineMatch = trimmed.match(/^-\s*match\s*:\s*(.+)$/);
    if (inlineMatch) {
      flush();
      currentIndent = indent;
      current = { match: stripQuotes(inlineMatch[1].trim()), labels: [] };
      continue;
    }
    // 规则项的续行：`- labels: ["ice"]`（同一列表项）
    const inlineLabels = trimmed.match(/^-\s*labels\s*:\s*(.+)$/);
    if (inlineLabels && current) {
      current.labels = parseLabelList(inlineLabels[1]);
      continue;
    }
    // 规则项的子键：`labels: [...]`
    if (trimmed.startsWith('labels:')) {
      if (!current) continue;
      // 缩进必须比规则项更深，否则是别的段的 labels。
      if (indent <= currentIndent) continue;
      current.labels = parseLabelList(trimmed.slice(7).trim());
      continue;
    }
    // 规则项的子键：`match: "xxx"`（分行写法）
    if (trimmed.startsWith('match:')) {
      if (!current) {
        current = { match: '', labels: [] };
        currentIndent = indent;
      }
      if (indent <= currentIndent) continue;
      current.match = stripQuotes(trimmed.slice(6).trim());
      continue;
    }
  }
  flush();

  if (rules.length === 0) return null;
  return { rules, fallback };
}

/**
 * 解析标签列表。
 *
 * 收两种形态：
 * - JSON 数组：`["ice", "sdp"]`
 * - 逗号分隔裸值：`ice, sdp`
 *
 * 标签是**短词**，不含逗号/引号 —— 所以逗号分隔不会切错。
 */
function parseLabelList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
      }
    } catch {
      // JSON 解析失败 → 退回逗号分隔（标签不含逗号，不会切错）。
    }
  }

  return trimmed
    .split(',')
    .map((v) => stripQuotes(v.trim()))
    .filter((v) => v.length > 0);
}

/** 去掉成对包裹的引号（与 core/policy/yaml.ts 同一口径）。 */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ─── 写集 → 标签 ────────────────────────────────────────────────────────────

/**
 * 把切片的**写集**按规则匹配成**标签集合**。
 *
 * 判据：写集条目 `w` 与规则模式 `pattern` —— 满足任一即命中：
 * - `w` 含 glob 通配 → 用 glob 匹配（`pathMatches(w, pattern)`）；
 * - `w` 是具体路径 → 用 glob 匹配它（`pathMatches(w, pattern)`）；
 * - 规则模式是**目录**（不以 glob 结尾但像目录）→ `w` 落在它下面。
 *
 * 统一用 `matchPath`（core/policy/engine.ts 的唯一实现）——
 * 全代码库的 glob 语义基准。抄一份必然漂移，而漂移的后果是
 * 「该收窄的没收窄」或「不该收窄的收窄了」。
 *
 * **写集条目是 glob 时**（如 `src/modules/ice/**`）：拿 glob 模式去匹配
 * 规则模式 —— `matchPath('src/modules/ice/**', 'src/modules/ice/**')` 为真，
 * 因为 `**` 能匹配零层或多层。实测确认这条路径可行。
 *
 * C3：纯计算。
 */
export function matchScopeLabels(
  writes: string[],
  rules: ScopeRule[],
  pathMatches: (filePath: string, pattern: string) => boolean,
): ScopeMatch {
  if (rules.length === 0) {
    return {
      labels: [],
      source: 'no-config',
      reason: '未配置 gate.scope —— 门禁跑全量（老行为）',
      matchedPatterns: [],
    };
  }

  const labels: string[] = [];
  const matchedPatterns: string[] = [];

  for (const rule of rules) {
    if (!rule.match || rule.labels.length === 0) continue;
    const hit = writes.some((w) => writeMatchesRule(w, rule.match, pathMatches));
    if (!hit) continue;
    if (!matchedPatterns.includes(rule.match)) matchedPatterns.push(rule.match);
    for (const label of rule.labels) {
      if (!labels.includes(label)) labels.push(label);
    }
  }

  if (labels.length === 0) {
    return {
      labels: [],
      source: 'fallback-full',
      reason:
        `写集没有命中任何作用域规则（已配 ${rules.length} 条规则）—— 退回全量` +
        `（宁可慢，不漏验）`,
      matchedPatterns,
    };
  }

  return {
    labels,
    source: 'config',
    reason: `写集命中 ${matchedPatterns.length} 条作用域规则 → 收窄到标签：${labels.join('、')}`,
    matchedPatterns,
  };
}

/**
 * 一个写集条目是否命中一条规则模式。
 *
 * 三种判据（任一成立即命中）：
 * 1. **glob 匹配** —— `pathMatches(w, pattern)`。写集是 glob 时，
 *    `**` 能匹配零层或多层，所以 `src/modules/ice/**` 能命中
 *    规则 `src/modules/ice/**`。
 * 2. **目录前缀** —— 规则以 `/` 结尾且 `w` 以它开头。
 * 3. **反向目录前缀** —— `w` 以 `/` 结尾且规则以它开头
 *    （写集是目录、规则指向它里面的东西）。
 */
function writeMatchesRule(
  write: string,
  pattern: string,
  pathMatches: (filePath: string, pattern: string) => boolean,
): boolean {
  const w = write.replace(/\\/g, '/');
  const p = pattern.replace(/\\/g, '/');
  if (!w || !p) return false;

  // 1) glob 匹配（双向都试：写集是 glob、规则是具体路径时也要能命中）。
  if (pathMatches(w, p)) return true;
  if (!p.includes('*') && !w.includes('*') && pathMatches(p, w)) return true;

  // 2) 规则是目录前缀。
  if (p.endsWith('/') && w.startsWith(p)) return true;

  // 3) 写集是目录前缀。
  if (w.endsWith('/') && p.startsWith(w)) return true;

  return false;
}

// ─── 作用域判定（写集 + 配置 + 人的显式要求）────────────────────────────────

/**
 * 判定一轮门禁的**作用域**（ADR-097）。
 *
 * 三种结果：
 * - `no-config`：没配 `gate.scope` → 跑全量（老行为）；
 * - `fallback-full`：配了规则但写集没命中 → 跑全量；
 * - `config`：写集命中 → 按标签收窄。
 *
 * **人显式说「这轮跑全量」时**（`forceFull`）→ 全量，
 * 且理由说清楚是**人要求的**，不是「配错了」。
 *
 * 这个判定是**纯函数** —— CLI 的干跑、Web 的门禁、executor 的真跑
 * 都调它，三处口径必须一致（否则「干跑时看到的」与「真跑时跑的」不一样，
 * 那干跑就没意义了）。
 */
export function resolveScope(
  writes: string[],
  scopeCfg: ScopeConfig | undefined,
  pathMatches: (filePath: string, pattern: string) => boolean,
  forceFull = false,
): ScopeMatch {
  if (forceFull) {
    return {
      labels: [],
      source: 'fallback-full',
      reason: '人显式要求跑全量（--full）—— 不做作用域收窄',
      matchedPatterns: [],
    };
  }

  if (!scopeCfg || scopeCfg.rules.length === 0) {
    return {
      labels: [],
      source: 'no-config',
      reason: '未配置 gate.scope —— 门禁跑全量（老行为）',
      matchedPatterns: [],
    };
  }

  return matchScopeLabels(writes, scopeCfg.rules, pathMatches);
}

// ─── ctest 枚举命令 ──────────────────────────────────────────────────────────

/**
 * 「ctest 词元在哪结束」这件事**只有一份实现** —— `diagnostics.ts` 的
 * `ctestInsertPoint()`。
 *
 * **为什么这里不再自己写一份**（2026-11-25，Linux CI 红了才暴露出来）：
 * 本文件原来有一份**逐字复制**的 `CTEST_TOKEN` / `CTEST_PREFIX` /
 * `CTEST_EXEC_EXTENSIONS` / `findCtestTokenEnd`。复制的那份**漏了引号边界** ——
 * 参数被插进路径引号**内部**，POSIX shell 把「路径+参数」当成一个 token，
 * 命令根本跑不起来（门禁报的是一个与被测代码毫不相干的错）。
 *
 * 诊断侧那份当时**恰好**也漏了同一个洞，所以两边一起坏、一起红 ——
 * 这就是 ADR-106 §5 说的那条老教训：
 * **同一个问题两处判定，必然走偏。** 修法不是「把两处都补上」，
 * 而是**收敛到一处**，让下一次没有第二处可漏。
 *
 * 两个模块同在 `core/gate/`，互相 import 不违反依赖方向（C2）。
 */

/**
 * 在一条 ctest 命令里**追加** `--show-only=json-v1`，用来枚举用例。
 *
 * **为什么是「追加」而不是「另起一条命令」**（ADR-097 技术验证 §2）：
 * 追加后原命令的 `--test-dir` / `-C Debug` / `--timeout` 等参数**全部
 * 自动继承** —— zelto 不需要再解析命令行各参数（那又是一份必然漂移的
 * 解析器，且各项目参数不同）。
 *
 * 返回 null 表示「这条命令不是 ctest 命令」—— 调用方不收窄它。
 * 纯字符串拼接，不执行任何东西（C3）。
 */
export function buildCtestEnumerateCommand(run: string): string | null {
  if (!run) return null;
  // 已经带了 --show-only → 不叠加（会互相覆盖）。
  if (/(?:^|\s)--show-only(?:\s|=)/.test(run)) return null;
  // 插入点由 diagnostics.ts 统一给（见上面「只有一份实现」的说明）：
  // 它会跳过词元后面紧跟的闭合引号 —— POSIX shell 里引号内是一个 token，
  // 参数插进引号内会把「路径+参数」变成文件名。
  const insertAt = ctestInsertPoint(run);
  if (insertAt === null) return null;
  return `${run.slice(0, insertAt)} --show-only=json-v1${run.slice(insertAt)}`;
}

// ─── ctest JSON → 精确用例名清单 ────────────────────────────────────────────

/**
 * `ctest --show-only=json-v1` 的输出形态（已实测）：
 *
 * ```json
 * { "tests": [
 *   { "name": "Ice.CandidateBuild",
 *     "properties": [ { "name": "LABELS", "value": ["ice","module"] } ] },
 *   { "name": "Sdp.ParseOffer",
 *     "properties": [ { "name": "LABELS", "value": ["module","sdp"] } ] }
 * ] }
 * ```
 *
 * **LABELS 的值是数组**，但老版本 CTest 可能给字符串 —— 两种都认。
 */
export interface CTestJsonTest {
  name?: unknown;
  properties?: Array<{ name?: unknown; value?: unknown }>;
}

/**
 * 从 ctest 的 JSON 输出里，精确筛出**带指定标签**的用例名。
 *
 * 判据：用例的 `LABELS` 属性**包含**任一目标标签。
 *
 * **为什么用标签而不是用例名正则**（ADR-097 决策二）：nimrtc 的用例名
 * （`test_ice_test.IceCandidateBuild`）**不含模块路径** —— 用例名反推
 * 源目录这条路对 nimrtc 根本不成立。而且正则的元字符在 Windows cmd 下
 * 是陷阱（ADR-096 实测：`|` 被打成管道符，命令直接崩）。
 *
 * 解析失败 / 没有 `tests` 数组 → 返回 null（调用方退回全量）。
 *
 * C3：纯计算。
 */
export function selectScopedTestNames(
  jsonText: string,
  labels: string[],
): { names: string[]; total: number } | null {
  if (!jsonText || !jsonText.trim()) return null;
  if (labels.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // JSON 解析失败 → 调用方退回全量（不许猜）。
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const tests = (parsed as { tests?: unknown }).tests;
  if (!Array.isArray(tests)) return null;

  const wanted = new Set(labels);
  const names: string[] = [];

  for (const t of tests as CTestJsonTest[]) {
    if (!t || typeof t.name !== 'string') continue;
    const name = t.name.trim();
    if (!name) continue;
    if (labelsOf(t).some((l) => wanted.has(l))) {
      if (!names.includes(name)) names.push(name);
    }
  }

  return { names, total: tests.length };
}

/**
 * 取一个用例的标签集合。
 *
 * `LABELS` 的值可能是数组（实测）也可能是字符串（老版本）—— 两种都认。
 * 属性名大小写不敏感（`LABELS` / `Labels`）。
 */
function labelsOf(test: CTestJsonTest): string[] {
  const props = test.properties;
  if (!Array.isArray(props)) return [];
  const out: string[] = [];
  for (const p of props) {
    if (!p || typeof p.name !== 'string') continue;
    if (p.name.toUpperCase() !== 'LABELS') continue;
    const value = p.value;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string' && v.trim()) out.push(v.trim());
      }
    } else if (typeof value === 'string') {
      for (const v of value.split(',')) {
        const t = v.trim();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

// ─── 清单文件 ───────────────────────────────────────────────────────────────
/**
 * 作用域收窄清单文件的前缀。
 *
 * 与 ADR-096 的 `GATE_NARROWING_MANIFEST_PREFIX` 分开 —— 两种清单
 * 语义不同（一个是「上次失败的用例」，一个是「本次作用域内的用例」），
 * 用同一个前缀会让人分不清工作目录里那个文件是干什么的。
 *
 * 同样带切片 id —— 并行切片各跑各的门禁，不能互相覆盖。
 */
export const GATE_SCOPE_MANIFEST_PREFIX = '.zelto-gate-scope-';

/**
 * 作用域清单的文件名。
 *
 * 带切片 id + 一个序号 —— 一条门禁命令可能有多条（每条 ctest 命令
 * 一份清单，因为每条命令的 `--test-dir` 可能不同，筛出来的用例集
 * 也可能不同）。
 */
export function scopeManifestFile(sliceId: string, index: number): string {
  return `${GATE_SCOPE_MANIFEST_PREFIX}${sanitizeForFilename(sliceId)}-${index}.txt`;
}

/**
 * 把切片 id 变成能安全当文件名的串。
 *
 * 与 ADR-096 的 `sanitizeForFilename` **同口径**（杜绝路径穿越 ——
 * 切片 id 若含 `../` 就能写到工作目录外面去）。
 *
 * **这里直接用 diagnostics.ts 那份**（2026-11-25 改）：
 * 原来本文件**独立复制**了一份，注释写的是「免得两处各改一处漏一处」——
 * 但那句话本身就把 ADR-106 §5 的老教训又犯了一遍：
 * **靠「小心别改漏」来保证一致，不是保证一致。**
 * 两份同名同逻辑的函数放在同一个依赖域里，下一次改一处就必然漂移。
 * 既然 scope.ts 已经从 diagnostics.ts 取插入点了，
 * 这个函数没理由再留一份。
 *
 * 清单**前缀**（`GATE_SCOPE_MANIFEST_PREFIX`）仍然各自不同 ——
 * 那是有意的：两个模块的清单文件不撞名。
 */
export { sanitizeForFilename };

/**
 * 清单文件的内容。
 *
 * 每行一个**精确用例名**（CTest 的 `--tests-from-file` 格式）。
 *
 * 末尾带换行 —— CTest 按行读，最后一行没有换行符时部分版本会漏。
 */
export function buildScopeManifestContent(names: string[]): string {
  return `${names.join('\n')}\n`;
}
