// 领域词汇表 —— 项目的「共享语言」
//
// C3: 纯文件读取 + 纯计算，不调模型、不触网
// C2: core/ 内，零第三方依赖，不 import adapters/
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
//
// zelto 的追溯链全是结构化产物：
//
//   需求 → 设计 → 版本计划 → 版本 → 切片 → 规格 → 测试 → 代码
//
// 每个环节都是**结构**，没有一处是**语言**。结果是：
//
//   - agent 被扔进项目后要自己猜行话，于是用 20 个词说 1 个词的事；
//   - 多个并行 agent 各自用不同的词描述同一件事，彼此看不懂对方的改动；
//   - 规格里的一个词，在两个 agent 眼里指两个东西 —— 而追溯链查不出来
//     （追溯判的是「有没有出处」，不是「出处说的是不是同一件事」）。
//
// 这正是 DDD 里 ubiquitous language 的作用：给项目一份共享词汇，
// 让人和 agent 用同一套词说话。
//
// ── 为什么放 core/ 而不是纯文档 ──────────────────────────────────────────
//
// 纯文档只能给人看。放 core/ 是因为它要能被**校验**：
//
//   `zelto glossary check` 拿词汇表去查规格正文，
//   报出「规格里用了表里没有的术语」与「表里的词在规格里从没被用过」。
//
// 这不是「对错」判定，是**一致性提醒** —— 术语没进表，往往意味着
// 这个人/agent 造了个新词而没告诉别人。
//
// 判定必须确定性（C3），所以这里只做**字面比对**：词表里有什么、
// 文本里出现了什么。没有语义理解，也不需要。

/** 词汇表里的一条术语 */
export interface GlossaryTerm {
  /** 术语本身（规范写法） */
  term: string;
  /** 意思（一句话） */
  meaning: string;
  /** 同义词 / 别名 —— 文本里出现这些也算用了这个词 */
  aliases: string[];
  /** 是否为受控术语（其它词不许用） */
  controlled: boolean;
}

/** 一份词汇表 */
export interface Glossary {
  /** 词汇表版本 */
  version: number;
  /** 最后更新时间 */
  updatedAt: string;
  /** 更新人 */
  updatedBy: string;
  /** 术语清单 */
  terms: GlossaryTerm[];
}

/** 词汇表检查的结论 */
export interface GlossaryCheckReport {
  /** 词表里有多少术语 */
  totalTerms: number;
  /** 被检查的文本里用到的、词表里有的术语 */
  usedTerms: string[];
  /** 文本里用了、但词表里没有的候选术语（需要人确认） */
  unknownTerms: string[];
  /** 词表里有、但文本里从没出现的术语（可能是废弃或写错了） */
  unusedTerms: string[];
  /** 有没有受控术语被绕过（用了它的非受控别名） */
  controlledViolations: Array<{ canonical: string; used: string }>;
}

/**
 * 词汇表的存储位置。
 *
 * 落在 `.zelto/glossary.json` —— 状态只在文件里（C1），
 * 且 `.zelto/**` 本来就在保护域里（C5），agent 改不了它。
 */
export const GLOSSARY_FILENAME = 'glossary.json';

/** 词表文件的形状（落在磁盘上的） */
interface GlossaryFile {
  version: number;
  updatedAt: string;
  updatedBy: string;
  terms: Array<{
    term: string;
    meaning: string;
    aliases?: string[];
    controlled?: boolean;
  }>;
}

/**
 * 解析词表文件内容。
 *
 * 容错：坏掉的字段用默认值，不让整个命令崩掉 ——
 * 词表是**辅助材料**，它坏了不该拦住人干活。
 */
export function parseGlossary(content: string): Glossary {
  let raw: GlossaryFile;
  try {
    raw = JSON.parse(content) as GlossaryFile;
  } catch {
    return { version: 1, updatedAt: '', updatedBy: '', terms: [] };
  }

  const terms: GlossaryTerm[] = [];
  if (Array.isArray(raw?.terms)) {
    for (const t of raw.terms) {
      if (!t || typeof t.term !== 'string' || !t.term.trim()) continue;
      terms.push({
        term: t.term.trim(),
        meaning: typeof t.meaning === 'string' ? t.meaning : '',
        aliases: Array.isArray(t.aliases)
          ? t.aliases.filter((a): a is string => typeof a === 'string' && !!a.trim())
          : [],
        controlled: t.controlled === true,
      });
    }
  }

  return {
    version: typeof raw?.version === 'number' ? raw.version : 1,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : '',
    updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : '',
    terms,
  };
}

/** 渲染成词表文件内容（写盘用） */
export function renderGlossary(glossary: Glossary): string {
  const file: GlossaryFile = {
    version: glossary.version,
    updatedAt: glossary.updatedAt,
    updatedBy: glossary.updatedBy,
    terms: glossary.terms.map((t) => ({
      term: t.term,
      meaning: t.meaning,
      aliases: t.aliases,
      controlled: t.controlled,
    })),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

/**
 * 检查文本对词汇表的使用。
 *
 * 判定全是**字面比对**：
 *   - 文本里出现了词表里的术语（或它的别名）→ 用到了这个词
 *   - 文本里出现了不在词表里的「像术语的」片段 → 候选未知术语
 *   - 受控术语的别名出现了而规范写法没出现 → 受控术语被绕过
 *
 * 「像术语的片段」的判据是启发式的（首字母大写的驼峰词、中文术语表里的词条），
 * 报出来的是**候选**，不是定论 —— 命令会说明这一点。
 *
 * @param text 被检查的文本（通常是规格正文）
 * @param glossary 词汇表
 */
export function checkGlossaryUsage(text: string, glossary: Glossary): GlossaryCheckReport {
  const usedTerms: string[] = [];
  const unusedTerms: string[] = [];
  const controlledViolations: Array<{ canonical: string; used: string }> = [];

  // 词表里的规范写法与别名，逐个在文本里找
  const known = new Set<string>();
  for (const t of glossary.terms) {
    known.add(t.term.toLowerCase());
    for (const a of t.aliases) known.add(a.toLowerCase());
  }

  for (const t of glossary.terms) {
    const canonicalHit = containsTerm(text, t.term);
    const aliasHit = t.aliases.find((a) => containsTerm(text, a));

    if (canonicalHit) {
      usedTerms.push(t.term);
    } else if (aliasHit) {
      usedTerms.push(t.term);
      // 受控术语被别名绕过 —— 报告出来，但不算「用错」，只提示规范写法
      if (t.controlled) {
        controlledViolations.push({ canonical: t.term, used: aliasHit });
      }
    } else {
      unusedTerms.push(t.term);
    }
  }

  // 未知术语候选：文本里的驼峰标识符 / 反引号代码片段
  const candidates = collectTermCandidates(text);
  const unknownTerms = candidates.filter((c) => !known.has(c.toLowerCase()));

  return {
    totalTerms: glossary.terms.length,
    usedTerms,
    unknownTerms: [...new Set(unknownTerms)],
    unusedTerms,
    controlledViolations,
  };
}

/**
 * 文本里有没有出现这个词。
 *
 * 边界：英文按**词边界**匹配（避免 `slice` 命中 `sliced`），
 * 中文直接子串匹配（中文没有词边界概念）。
 */
function containsTerm(text: string, term: string): boolean {
  if (!term) return false;
  if (/^[\x20-\x7e]+$/.test(term)) {
    // 纯 ASCII 词 → 词边界匹配
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i');
    return re.test(text);
  }
  return text.includes(term);
}

/**
 * 收集「像术语」的候选片段。
 *
 * 两类：
 *   1. 反引号里的代码标识符（`SliceStore`、`extractRequirements`）
 *   2. 文本里的驼峰词（SliceStore、GateResult）
 *
 * 这些是 agent 之间最需要对齐的词 —— 它们是**代码里的名字**，
 * 而代码里的名字一旦两个 agent 各自造一个，追溯链就断了。
 */
function collectTermCandidates(text: string): string[] {
  const found: string[] = [];

  const backticked = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = backticked.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (!candidate || /\s/.test(candidate)) continue;
    // 只要标识符 —— 排除路径（路径不是术语）
    if (candidate.includes('/')) continue;
    if (!/^[A-Za-z_][\w]*$/.test(candidate)) continue;
    found.push(candidate);
  }

  // 驼峰词（至少两段、首段大写）
  const camel = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g;
  while ((m = camel.exec(text)) !== null) {
    found.push(m[1]);
  }

  return found;
}
