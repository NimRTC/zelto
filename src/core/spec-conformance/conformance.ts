// 规格符合性判定 —— 「这段改动忠实实现了规格吗」
//
// C3: 纯文件读取 + 纯计算，不调模型、不触网
// C2: core/ 内，零第三方依赖，不 import adapters/
//
// ── 为什么要有这一层 ──────────────────────────────────────────────────────
//
// 追溯链保证的是「这段代码**有出处**」—— 追溯项非空、契约与测试落到具体文件。
// 但追溯判定回答不了另一个问题：
//
//   **出处说了「要做什么」，代码真的做了吗？**
//
// 门禁②跑验收测试，测试通过 ≠ 实现忠实于规格。规格里没写、代码里多出来的
// （scope creep）现在没人查；规格里写了、代码里没做的，现在也没人查。
//
// 这一层填的就是这个洞。它是 mattpocock `/code-review` 那个「Spec 轴」的
// **确定性实现** —— 他那版是两个 LLM subagent 并行判，人读的是模型的判断；
// 这里同一件事由纯计算完成（C3），结论可复现、可进事件流、可当闸门。
//
// ── 为什么不是「另一个 LLM 检查」──
//
// C7 规定 llm/ 的产出只能当草稿。判定要能进闸门，就必须是确定性的。
// 所以这里的做法是：**把「规格说了什么」与「代码里有什么」都变成可比对的结构**，
// 再用确定性规则比对。模型可以在事后给人写一份解读草稿，但闸门只认确定性结论。
//
// ── 三类结论 ──────────────────────────────────────────────────────────────
//
//   implemented   —— 规格要求的，代码里有证据
//   missing       —— 规格要求的，代码里找不到证据（可能没实现）
//   unrequested   —— 代码里有的，规格没要求（scope creep）
//
// 「证据」的定义要保守 —— 判定宁严勿宽：
// 找不到证据说成 missing 可能是误报（规格写得抽象），
// 但把没实现的算成 implemented 是更严重的漏报。

/** 一条规格要求 */
export interface SpecRequirement {
  /** 要求原文（验收标准 / 需求条目） */
  text: string;
  /** 从要求里提到的路径（可能是空 —— 抽象要求提不出路径） */
  paths: string[];
  /** 从要求里提到的标识符 / 代码符号（反引号里的非路径片段） */
  symbols: string[];
  /** 要求里提到的「动词性」提示词 —— 用来粗判这条要求可能对应哪种实现形态 */
  kind: RequirementKind;
}

/** 要求的粗分类 —— 由文本里的动词/名词确定性地推出 */
export type RequirementKind =
  /** 「存在 / 提供 / 支持」—— 应当有对应的符号或文件 */
  | 'existence'
  /** 「返回 / 报错 / 输出」—— 应当有行为证据 */
  | 'behavior'
  /** 「一致 / 不变 / 保持」—— 应当有测试或断言证据 */
  | 'invariant'
  /** 分不出来 */
  | 'generic';

/** 改动里的一个文件 */
export interface ChangedFile {
  /** 相对仓库根的路径（正斜杠） */
  path: string;
  /** 新增 / 修改 / 删除 */
  status: 'A' | 'M' | 'D' | 'R' | 'C';
  /** 新增行数 */
  added: number;
  /** 删除行数 */
  deleted: number;
}

/** 一条要求的判定结果 */
export interface RequirementVerdict {
  /** 要求原文 */
  text: string;
  kind: RequirementKind;
  /** 判定 */
  status: 'implemented' | 'missing' | 'unknown';
  /** 证据：命中要求的文件（相对仓库根） */
  evidence: string[];
  /** 为什么判不了（status 为 unknown 时有值） */
  reason: string | null;
}

/** 一处范围蔓延 */
export interface ScopeCreep {
  /** 改动的文件 */
  path: string;
  /** 状态 */
  status: string;
  /** 判定依据 */
  reason: string;
}

/** 规格符合性判定结论 */
export interface ConformanceReport {
  /** 规格里的要求总数 */
  totalRequirements: number;
  /** 判定为已实现 */
  implemented: number;
  /** 判定为未实现 */
  missing: number;
  /** 判不了（要求太抽象，找不到可判定的证据） */
  unknown: number;
  /** 逐条结论 */
  requirements: RequirementVerdict[];
  /** 范围蔓延清单 */
  scopeCreep: ScopeCreep[];
  /** 改动涉及的、规格没提到的文件（仅供参考，可能合理） */
  unmentionedFiles: string[];
  /** 本次判定覆盖到的文件数 */
  filesConsidered: number;
}

/**
 * 判定「改动 vs 规格」。
 *
 * @param specText 规格全文
 * @param changedFiles agent 实际改动的文件
 * @param fileContents 改动文件的当前内容（相对仓库根 → 文本）。读不到就不传。
 * @param options.managedPaths zelto **自己**放的文件（规格副本、切片文件、
 *   约束包镜像等）。这些不是 agent 的产物，不该算成范围蔓延。
 * @returns 符合性判定结论
 */
export function evaluateConformance(
  specText: string,
  changedFiles: ChangedFile[],
  fileContents: Map<string, string> = new Map(),
  options: { managedPaths?: string[] } = {},
): ConformanceReport {
  const requirements = extractRequirements(specText);
  const mentioned = extractMentionedPaths(specText);

  const touched = new Set(changedFiles.map((f) => f.path));
  const mentionedSet = new Set(mentioned);
  const managed = (options.managedPaths ?? []).map((p) => p.replace(/\\/g, '/'));

  // ─── 逐条要求找证据 ────────────────────────────────────────────────────
  const verdicts: RequirementVerdict[] = requirements.map((req) => {
    const evidence = findEvidence(req, touched, fileContents);

    if (evidence.length > 0) {
      return { text: req.text, kind: req.kind, status: 'implemented', evidence, reason: null };
    }

    // 找不到证据 —— 分「确定没做」与「判不了」两种。
    //
    // 判据：要求里提不出任何可核对的锚点（路径或符号）时，
    // 它就是「判不了」而不是「没做」——
    // 拿一条抽象要求（「解析器应当健壮」）去对代码做字符串匹配，
    // 必然对不上，那是判据的局限，不是实现的缺陷。
    if (req.paths.length === 0 && req.symbols.length === 0) {
      return {
        text: req.text,
        kind: req.kind,
        status: 'unknown',
        evidence: [],
        reason: '要求里没有可核对的锚点（既无路径也无标识符）—— 无法用确定性判据核实',
      };
    }

    return {
      text: req.text,
      kind: req.kind,
      status: 'missing',
      evidence: [],
      reason: null,
    };
  });

  // ─── 范围蔓延 ──────────────────────────────────────────────────────────
  // 改动的文件既不在规格提到的路径里、也不是它的泛化前缀 → 可疑。
  //
  // 「可疑」而不是「越界」：规格写得简略时，改动文件本来就不一定被点名
  // （比如规格只说「实现 X」，agent 顺手改了同模块的另一个文件）。
  // 真正的硬边界由写集守卫管（C9），这一层只负责**指出来给人看**。
  //
  // **zelto 自己的托管文件不算蔓延**（managedPaths）：
  // 切片文件（`.zelto/slices/<id>.json`）、规格副本、约束包镜像 ——
  // 这些是 zelto 放进去的，不是 agent 的产物。
  // 把它们算成蔓延会让每次检查都报一堆假阳性，久了人就懒得看了 ——
  // 报假阳性的检查等于没检查。
  const scopeCreep: ScopeCreep[] = [];
  const unmentionedFiles: string[] = [];

  for (const file of changedFiles) {
    if (mentionedSet.has(file.path)) continue;
    if (isCoveredByMention(file.path, mentionedSet)) continue;
    if (isManaged(file.path, managed)) continue;
    unmentionedFiles.push(file.path);
    scopeCreep.push({
      path: file.path,
      status: file.status,
      reason: '规格正文没有提到这个文件 —— 改动超出了规格点名的范围',
    });
  }

  return {
    totalRequirements: requirements.length,
    implemented: verdicts.filter((v) => v.status === 'implemented').length,
    missing: verdicts.filter((v) => v.status === 'missing').length,
    unknown: verdicts.filter((v) => v.status === 'unknown').length,
    requirements: verdicts,
    scopeCreep,
    unmentionedFiles,
    filesConsidered: changedFiles.length,
  };
}

/**
 * 为一条要求找证据。
 *
 * 证据有两种形态：
 *   1. **路径证据** —— 改动里动过这条要求提到的路径（最强）
 *   2. **符号证据** —— 改动文件的当前内容里出现了要求提到的标识符
 *
 * 符号证据要求文件在 `fileContents` 里；读不到就只认路径证据。
 *
 * 符号匹配用**词边界**而不是裸子串：
 * 裸子串会让 `action` 匹配到 `transaction`、`deny` 匹配到 `denyAll` ——
 * 那是假证据，会把没实现的算成实现了（D3：宁严勿宽，宁可漏报不可误判）。
 */
function findEvidence(
  req: SpecRequirement,
  touched: Set<string>,
  fileContents: Map<string, string>,
): string[] {
  const evidence: string[] = [];

  // 1) 路径证据
  for (const path of req.paths) {
    for (const touchedPath of touched) {
      if (touchedPath === path || touchedPath.startsWith(`${path}/`) || path.startsWith(`${touchedPath}/`)) {
        evidence.push(touchedPath);
      }
    }
  }
  if (evidence.length > 0) return [...new Set(evidence)];

  // 2) 符号证据
  if (req.symbols.length === 0) return [];
  for (const [path, content] of fileContents) {
    if (!touched.has(path)) continue;
    if (req.symbols.some((sym) => containsSymbol(content, sym))) {
      evidence.push(path);
    }
  }
  return [...new Set(evidence)];
}

/** 改动文件是否被某个被提到的路径覆盖（前缀关系） */
function isCoveredByMention(path: string, mentioned: Set<string>): boolean {
  for (const m of mentioned) {
    if (path === m || path.startsWith(`${m}/`) || m.startsWith(`${path}/`)) return true;
  }
  return false;
}

/**
 * 这个文件是不是 zelto 自己的托管文件。
 *
 * 判据：路径**等于**某个托管路径，或**落在**某个托管目录下
 * （验收目录 `tests/acceptance/<id>/` 是目录，目录里的每个文件都是托管的）。
 */
function isManaged(path: string, managed: string[]): boolean {
  for (const m of managed) {
    if (!m) continue;
    const normalized = m.replace(/\/$/, '');
    if (path === normalized) return true;
    if (path.startsWith(`${normalized}/`)) return true;
  }
  return false;
}

/**
 * 内容里有没有这个符号 —— 按**词边界**匹配。
 *
 * 为什么不用裸 `includes`：裸子串会让 `action` 匹配到 `transaction`、
 * `deny` 匹配到 `denyAll`。那是**假证据** —— 会把没实现的算成实现了。
 *
 * 边界用 `\w`（字母数字下划线）：`$scope` 里的 `scope` **是**同一个标识符
 * （`$` 只是标识符的合法前缀），所以 `$` 不能算边界 —— 否则
 * 「`scope` 应当被支持」会因为代码写成 `$scope` 而找不到证据。
 */
function containsSymbol(content: string, symbol: string): boolean {
  if (!symbol) return false;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`);
  return re.test(content);
}

// ─── 规格文本解析 ──────────────────────────────────────────────────────────

/**
 * 从规格正文里提取要求条目。
 *
 * 复用 `core/spec/trace-extract.ts` 的条目提取语义 ——
 * 「验收标准」优先，缺失时退到「需求」。两份实现的差别只在后面
 * 「从条目里抽锚点」这一步。
 */
export function extractRequirements(specText: string): SpecRequirement[] {
  const items = collectRequirementItems(specText);
  return items.map((text) => buildRequirement(text));
}

/**
 * 收集要求条目 —— 编号列表（验收标准/需求）与无序列表（需求）。
 *
 * 独立实现而不是直接 import `core/spec/trace-extract.ts`：
 * 那一层是为**追溯物化**设计的（输出 `{ text, source }`），
 * 这里要的是带锚点的结构。共用条目语义、但锚点抽取各自负责，
 * 比强行改公共接口更省事，也不会动到冻结判定的行为。
 */
function collectRequirementItems(specText: string): string[] {
  // 顺序即优先级：**验收标准在前，需求在后**（与 core/spec/trace-extract.ts 同口径）。
  // 只有规格没写验收标准时，才退到需求章节。
  const sections: Array<{ headingRe: RegExp }> = [
    { headingRe: /^(?:验收标准|Acceptance(?:\s+Criteria)?)$/i },
    { headingRe: /^(?:需求|Requirements?)$/i },
  ];

  for (const section of sections) {
    const body = extractSectionBody(specText, section.headingRe);
    if (body === null) continue;
    const items = parseItems(body, true);
    if (items.length > 0) return items;
  }

  return [];
}

/** 取某个标题的正文体（标题不存在返回 null） */
function extractSectionBody(text: string, headingRe: RegExp): string | null {
  const lines = text.split('\n');
  const body: string[] = [];
  let level = 0;
  let found = false;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const headingLevel = heading[1].length;
      if (found) {
        if (headingLevel <= level) break;
        body.push(line);
        continue;
      }
      if (headingRe.test(heading[2].trim())) {
        found = true;
        level = headingLevel;
      }
      continue;
    }
    if (found) body.push(line);
  }

  return found ? body.join('\n') : null;
}

/**
 * 取列表条目 —— 编号或无序，续行并入上一条。
 *
 * 续行规则与 `core/spec/trace-extract.ts` 一致：缩进的非列表行是上一条的延续。
 */
function parseItems(body: string, ordered: boolean): string[] {
  const items: string[] = [];
  let current: string | null = null;

  const flush = (): void => {
    if (current !== null) {
      const t = current.trim();
      if (t) items.push(t);
    }
    current = null;
  };

  for (const line of body.split('\n')) {
    if (ordered) {
      const m = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
      if (m) {
        flush();
        current = m[1].trim();
        continue;
      }
    } else {
      const m = line.match(/^\s*[-*]\s+(.+?)\s*$/);
      if (m) {
        flush();
        current = m[1].trim();
        continue;
      }
    }
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

  return items;
}

/** 从要求条目里抽锚点 —— 路径、标识符与命令 */
function buildRequirement(text: string): SpecRequirement {
  const backticked: string[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (!candidate) continue;
    backticked.push(candidate);
  }

  const paths: string[] = [];
  const symbols: string[] = [];
  const commands: string[] = [];

  for (const candidate of backticked) {
    if (looksLikePath(candidate)) {
      paths.push(candidate);
    } else if (looksLikeCommand(candidate)) {
      // 命令形态的锚点（`zelto policy edit foo --action deny`）——
      // 它的可核对部分不是整条命令，而是命令里的**标识符**。
      // 见 extractCommandSymbols。
      commands.push(candidate);
      symbols.push(...extractCommandSymbols(candidate));
    } else if (looksLikeIdentifier(candidate)) {
      symbols.push(candidate);
    }
    // 既不是路径、也不是标识符、也不是命令 —— 例如 `不变量必须成立`
    // 这种中文短语：它不是可核对的锚点，跳过（不算路径也不算符号）。
  }

  return {
    text,
    paths: [...new Set(paths)],
    symbols: [...new Set(symbols)],
    kind: classifyRequirement(text),
  };
}

/**
 * 这个反引号片段是不是一条命令。
 *
 * 判据：含空白，且第一个词像是命令名（`zelto` / `npm` / `pnpm` / `git` 等
 * 以字母开头的词），后面跟着参数。
 *
 * 为什么单独认这类：规格里大量要求写成「`zelto policy edit foo --action deny`
 * 将规则 action 改为 deny」—— 这条要求的**可核对锚点**是命令里的标识符
 * （`policy` / `edit` / `action` / `deny`），不是整条命令字符串。
 * 把它们当成「无锚点」会让这类要求全部判成「判不了」，
 * 而它们其实是**可以核对**的 —— 代码里出现这些标识符就是证据。
 */
function looksLikeCommand(s: string): boolean {
  if (!/\s/.test(s)) return false;
  const first = s.split(/\s+/)[0];
  // 命令名：以字母开头的词，或路径样的可执行文件
  return /^[a-z][\w.-]*$/i.test(first);
}

/**
 * 从命令里抽出可核对的标识符。
 *
 * 取命令的**各个词**（去掉参数分隔符与引号），只保留像标识符的：
 * 字母开头、不含 `=`、不含 `-` 开头（那是旗标名）。
 *
 * 为什么连旗标名也去掉：`--action` 是旗标名，它出现在代码里的概率低
 * （代码里写的是 `action`），留着只会让证据判据变得不稳定。
 */
function extractCommandSymbols(command: string): string[] {
  const symbols: string[] = [];
  for (const raw of command.split(/\s+/)) {
    const word = raw.replace(/^["'`]+|["'`]+$/g, '');
    if (!word) continue;
    if (word.startsWith('-')) continue; // 旗标
    if (word.includes('=')) continue; // --key=value
    if (!/^[a-zA-Z_][\w.]*$/.test(word)) continue; // 路径、数字、符号
    symbols.push(word);
  }
  return symbols;
}

/** 这个反引号片段是不是路径 */
function looksLikePath(s: string): boolean {
  if (s.includes('/')) return true;
  if (/^[\w.-]+\.[a-zA-Z]{1,6}$/.test(s)) return true; // foo.ts / bar.md
  return false;
}

/**
 * 这个反引号片段是不是一个**可核对的标识符**。
 *
 * 判据：像代码标识符（字母/下划线开头，只含单词字符与 `.`）。
 *
 * 为什么中文短语不算：`不变量必须成立` 是**自然语言**，
 * 拿它去代码里做字面比对必然对不上 —— 那不是证据，是噪声。
 * 把它当锚点会让这类要求永远判成「未实现」，那是闸门误报。
 */
function looksLikeIdentifier(s: string): boolean {
  return /^[A-Za-z_][\w.]*$/.test(s);
}

/**
 * 由文本确定性地推出要求的粗分类。
 *
 * 关键词表是固定的 —— 同一段文字永远推出同一个分类（C3）。
 * 分类只影响报告的呈现与「判不了」的措辞，不参与阻断判定。
 */
function classifyRequirement(text: string): RequirementKind {
  if (/(存在|提供|支持|具备|拥有|新增|增加|包含|导出|定义)/.test(text)) return 'existence';
  if (/(返回|报错|提示|输出|拒绝|允许|禁止|抛出|响应)/.test(text)) return 'behavior';
  if (/(一致|不变|保持|相同|等于|默认为)/.test(text)) return 'invariant';
  return 'generic';
}

/**
 * 从规格正文里提取提到的路径。
 *
 * 判据：反引号包裹且含路径特征，或含 `/` 且有已知扩展名。
 */
export function extractMentionedPaths(specText: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const add = (p: string): void => {
    const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    paths.push(norm);
  };

  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(specText)) !== null) {
    const candidate = m[1].trim();
    if (!candidate || /\s/.test(candidate)) continue;
    if (looksLikePath(candidate)) add(candidate);
  }

  // 裸路径（不在反引号里）：带目录分隔符且有已知扩展名
  const bare = /(?:^|[\s（(「【])((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})/g;
  while ((m = bare.exec(specText)) !== null) {
    add(m[1]);
  }

  return paths;
}
