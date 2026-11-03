// AI Chat Adapter — Intent Router (L2)
// Uses keyword / pattern matching to classify natural-language input into intents.
// No LLM calls — purely deterministic rules.

import type { Intent, IntentCategory, RouterResult } from './types.js';

// ─── Pattern Definitions ────────────────────────────────────────────────────────

interface Pattern {
  /** Regex to test against the normalized input */
  regex: RegExp;
  /** The intent category */
  category: IntentCategory;
  /** The action verb */
  action: string;
  /** Parameter extractors: key → capture group index */
  paramKeys: Record<string, number>;
  /** Optional: match priority (higher wins when multiple patterns match) */
  priority?: number;
}

const PATTERNS: Pattern[] = [
  // ── help ─────────────────────────────────────────────────────────────────
  {
    regex: /^(帮助|帮助\s*$|help|\?|怎么用|命令|commands?)$/i,
    category: 'help',
    action: 'help',
    paramKeys: {},
    priority: 10,
  },

  // ── slice create ─────────────────────────────────────────────────────────
  {
    regex: /^创建(一[个张])?(新\s*)?切片\s*(.+)?$/i,
    category: 'slice',
    action: 'create',
    paramKeys: { sliceId: 3 },
    priority: 5,
  },
  {
    regex: /^(create|new)\s+(slice\s+)?(.+)$/i,
    category: 'slice',
    action: 'create',
    paramKeys: { sliceId: 3 },
    priority: 5,
  },

  // ── slice open ───────────────────────────────────────────────────────────
  {
    regex: /^(打开|查看|open)\s+切片\s+(.+)$/i,
    category: 'slice',
    action: 'open',
    paramKeys: { sliceId: 2 },
  },
  {
    regex: /^open\s+(slice\s+)?(.+)$/i,
    category: 'slice',
    action: 'open',
    paramKeys: { sliceId: 2 },
  },

  // ── slice advance ────────────────────────────────────────────────────────
  {
    regex: /^(推进|继续|advance|next)\s*(切片)?\s*(.+)?$/i,
    category: 'slice',
    action: 'advance',
    paramKeys: { sliceId: 3 },
  },

  // ── slice freeze ─────────────────────────────────────────────────────────
  {
    regex: /^(冻结|freeze)\s+切片\s+(.+)$/i,
    category: 'slice',
    action: 'freeze',
    paramKeys: { sliceId: 2 },
  },
  {
    regex: /^freeze\s+(slice\s+)?(.+)$/i,
    category: 'slice',
    action: 'freeze',
    paramKeys: { sliceId: 2 },
  },

  // ── slice list ───────────────────────────────────────────────────────────
  {
    regex: /^(列出|查看|list|show)\s*(所有)?\s*(切片|slices?)\s*$/i,
    category: 'slice',
    action: 'list',
    paramKeys: {},
  },

  // ── slice status ─────────────────────────────────────────────────────────
  {
    regex: /^(看看|查看|status|状态)\s*(切片\s*)?(.+)\s*(的)?(状态|status)?$/i,
    category: 'slice',
    action: 'status',
    paramKeys: { sliceId: 3 },
  },
  {
    regex: /^status\s+(of\s+)?(.+)$/i,
    category: 'slice',
    action: 'status',
    paramKeys: { sliceId: 2 },
  },

  // ── slice plan generate ──────────────────────────────────────────────────
  {
    regex: /^(为|for)?\s*(.+)\s*(生成|计划|plan)\s*(计划|plan)?$/i,
    category: 'slice-plan',
    action: 'generate',
    paramKeys: { sliceId: 2 },
  },
  {
    regex: /^(plan|generate)\s+(plan\s+)?(for\s+)?(.+)$/i,
    category: 'slice-plan',
    action: 'generate',
    paramKeys: { sliceId: 4 },
  },

  // ── slice plan approve ───────────────────────────────────────────────────
  {
    regex: /^(批准|approve)\s*(计划|plan)\s*(of\s+)?(.+)$/i,
    category: 'slice-plan',
    action: 'approve',
    paramKeys: { sliceId: 4 },
  },
  {
    regex: /^approve\s+(plan\s+)?(for\s+)?(.+)$/i,
    category: 'slice-plan',
    action: 'approve',
    paramKeys: { sliceId: 3 },
  },

  // ── slice plan reject ────────────────────────────────────────────────────
  {
    regex: /^(拒绝|reject)\s*(计划|plan)\s*(of\s+)?(.+)$/i,
    category: 'slice-plan',
    action: 'reject',
    paramKeys: { sliceId: 4 },
  },
  {
    regex: /^reject\s+(plan\s+)?(for\s+)?(.+)$/i,
    category: 'slice-plan',
    action: 'reject',
    paramKeys: { sliceId: 3 },
  },

  // ── gate check ───────────────────────────────────────────────────────────
  {
    regex: /^(检查|check)\s*(切片\s*)?(.+)\s*(是否)?(合规|合格|通过)?$/i,
    category: 'gate',
    action: 'check',
    paramKeys: { sliceId: 3 },
  },
  {
    regex: /^check\s+(slice\s+)?(.+)$/i,
    category: 'gate',
    action: 'check',
    paramKeys: { sliceId: 2 },
  },

  // ── gate approve / pass ──────────────────────────────────────────────────
  {
    regex: /^(通过|批准|approve|pass)\s*(切片\s*)?(.+)$/i,
    category: 'gate',
    action: 'approve',
    paramKeys: { sliceId: 3 },
  },
  {
    regex: /^approve\s+(slice\s+)?(.+)$/i,
    category: 'gate',
    action: 'approve',
    paramKeys: { sliceId: 2 },
  },

  // ── gate reject ──────────────────────────────────────────────────────────
  {
    regex: /^(驳回|拒绝|reject)\s*(切片\s*)?(.+)$/i,
    category: 'gate',
    action: 'reject',
    paramKeys: { sliceId: 3 },
  },
  {
    regex: /^reject\s+(slice\s+)?(.+)$/i,
    category: 'gate',
    action: 'reject',
    paramKeys: { sliceId: 2 },
  },

  // ── gate waive ───────────────────────────────────────────────────────────
  {
    regex: /^(撤销|豁免|waive)\s*(检查\s*)?(.+)$/i,
    category: 'gate',
    action: 'waive',
    paramKeys: { sliceId: 3 },
  },
  {
    regex: /^waive\s+(check\s+)?(for\s+)?(.+)$/i,
    category: 'gate',
    action: 'waive',
    paramKeys: { sliceId: 3 },
  },

  // ── gate override ────────────────────────────────────────────────────────
  {
    regex: /^(强制|override|force)\s*(放行|pass|through)?\s*(切片\s*)?(.+)$/i,
    category: 'gate',
    action: 'override',
    paramKeys: { sliceId: 4 },
  },
  {
    regex: /^override\s+(gate\s+)?(for\s+)?(.+)$/i,
    category: 'gate',
    action: 'override',
    paramKeys: { sliceId: 3 },
  },

  // ── stall create ─────────────────────────────────────────────────────────
  {
    regex: /^(标记|创建|create|mark)\s*(卡点|stall)\s*(.+)?$/i,
    category: 'stall',
    action: 'create',
    paramKeys: { sliceId: 3 },
  },
  {
    regex: /^(stall|卡点)\s*(创建|create|new)\s*(.+)?$/i,
    category: 'stall',
    action: 'create',
    paramKeys: { sliceId: 3 },
  },

  // ── stall resolve ────────────────────────────────────────────────────────
  {
    regex: /^(解除|解决|resolve|unblock)\s*(卡点|stall)\s*(.+)?$/i,
    category: 'stall',
    action: 'resolve',
    paramKeys: { sliceId: 3 },
  },
  {
    regex: /^(resolve|unblock)\s+(stall\s+)?(for\s+)?(.+)$/i,
    category: 'stall',
    action: 'resolve',
    paramKeys: { sliceId: 4 },
  },

  // ── stall list ───────────────────────────────────────────────────────────
  {
    regex: /^(列出|查看|list)\s*(所有)?\s*(卡点|stalls?)\s*$/i,
    category: 'stall',
    action: 'list',
    paramKeys: {},
  },

  // ── event list ───────────────────────────────────────────────────────────
  {
    regex: /^(查看|list|show)\s*(事件|event|日志|log)\s*(日志|log)?\s*(.+)?$/i,
    category: 'event',
    action: 'list',
    paramKeys: { sliceId: 4 },
  },
  {
    regex: /^(events?|日志|事件)\s*(of\s+)?(.+)?$/i,
    category: 'event',
    action: 'list',
    paramKeys: { sliceId: 3 },
  },
  {
    regex: /^(最近|recent)\s*(事件|events?|日志|logs?)\s*(.+)?$/i,
    category: 'event',
    action: 'list',
    paramKeys: { sliceId: 3 },
  },

  // ── agent create ─────────────────────────────────────────────────────────
  {
    regex: /^(生成|创建|create|new)\s*(一[个张])?\s*(agent|代理)\s*(.+)?$/i,
    category: 'agent',
    action: 'create',
    paramKeys: { name: 4 },
  },

  // ── agent list ───────────────────────────────────────────────────────────
  {
    regex: /^(列出|list|show)\s*(所有)?\s*(agents?|代理)\s*$/i,
    category: 'agent',
    action: 'list',
    paramKeys: {},
  },

  // ── agent status ─────────────────────────────────────────────────────────
  {
    regex: /^(查看|status|状态)\s*(agent|代理)\s*(.+)$/i,
    category: 'agent',
    action: 'status',
    paramKeys: { agentId: 3 },
  },
  {
    regex: /^agent\s+status\s+(.+)$/i,
    category: 'agent',
    action: 'status',
    paramKeys: { agentId: 1 },
  },
];

// ─── Router ──────────────────────────────────────────────────────────────────────

/**
 * Parse a natural-language input string into a structured intent.
 *
 * Uses regex-based pattern matching against a set of known patterns.
 * Returns the highest-confidence match, or an 'unknown' intent if nothing matches.
 *
 * @param input — raw user input (may include leading/trailing whitespace)
 * @returns a RouterResult with the parsed intent and confidence score
 */
export function route(input: string): RouterResult {
  const normalized = input.trim();

  if (!normalized) {
    return {
      intent: { category: 'unknown', action: 'unknown', params: {} },
      confidence: 1,
    };
  }

  let bestMatch: { pattern: Pattern; match: RegExpExecArray } | null = null;
  let bestPriority = -1;

  for (const pattern of PATTERNS) {
    const m = pattern.regex.exec(normalized);
    if (m) {
      const priority = pattern.priority ?? 1;
      if (priority > bestPriority) {
        bestMatch = { pattern, match: m };
        bestPriority = priority;
      }
    }
  }

  if (!bestMatch) {
    return {
      intent: { category: 'unknown', action: 'unknown', params: {} },
      confidence: 0,
    };
  }

  const { pattern, match } = bestMatch;

  // Extract parameters
  const params: Record<string, string> = {};
  for (const [key, groupIdx] of Object.entries(pattern.paramKeys)) {
    const raw = match[groupIdx];
    if (raw && raw.trim()) {
      params[key] = raw.trim();
    }
  }

  return {
    intent: {
      category: pattern.category,
      action: pattern.action,
      params,
    },
    confidence: bestPriority >= 5 ? 0.9 : 0.7,
  };
}

/**
 * Get a human-readable description of a category, for use in help output.
 */
export function categoryLabel(category: IntentCategory): string {
  const labels: Record<IntentCategory, string> = {
    slice: '切片操作 (create, open, advance, freeze, list, status)',
    gate: '门禁操作 (check, approve, reject, waive, override)',
    stall: '卡点操作 (create, resolve, list)',
    'slice-plan': '切片计划 (generate, approve, reject)',
    event: '事件查看 (list)',
    agent: 'Agent 操作 (create, list, status)',
    help: '帮助',
    unknown: '未识别',
  };
  return labels[category];
}
