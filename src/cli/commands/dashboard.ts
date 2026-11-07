// Dashboard — project bird's-eye view
// Layers: ① Abnormalities ② Releases ③ Version Plans ④ Code Areas (collapsed)
// Usage: zelto dashboard [--watch] [--open] [--output <path>] [--tty] [--json]

import { existsSync, readFileSync, readdirSync, writeFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { register, ZELTO_DIR } from './shared.js';
import { loadReleases, type ReleaseDef } from './releases.js';
import { detectSliceType, type SliceType } from '../../core/gate/types.js';
import { colors } from '../color.js';
import {
  collectCosts,
  fmtCost,
  fmtLimit,
  fmtTokens,
  readBudgetLimit,
  readPendingSigns,
  sumCosts,
  topSlicesByTokens,
  type CostTotals,
  type SliceCost,
} from './dashboard-cost.js';

// ─── Area Mapping ────────────────────────────────────────────────────────────

const AREA_DEFS = [
  { key: 'cli',        label: 'CLI 命令层',   icon: '🖥️',  order: 1 },
  { key: 'core-slice',  label: 'Core / 切片',  icon: '🧩',  order: 2 },
  { key: 'core-policy', label: 'Core / 策略',  icon: '📋',  order: 3 },
  { key: 'core-gate',   label: 'Core / 门禁',  icon: '🚧',  order: 4 },
  { key: 'core-events', label: 'Core / 事件',  icon: '📡',  order: 5 },
  { key: 'core-stall',  label: 'Core / Stall', icon: '⚠️',  order: 6 },
  { key: 'core-sched',  label: 'Core / 调度',  icon: '⏱️',  order: 7 },
  { key: 'core-other',  label: 'Core / 基础',  icon: '⚙️',  order: 8 },
  { key: 'adapters',    label: '适配器层',     icon: '🔌',  order: 9 },
  { key: 'llm',         label: 'LLM 集成',     icon: '🤖',  order: 10 },
  { key: 'hook',        label: 'Hook 系统',    icon: '🔗',  order: 11 },
  { key: 'contracts',   label: '契约 Schema',  icon: '📐',  order: 12 },
  { key: 'specs',       label: '规格文档',     icon: '📄',  order: 13 },
  { key: 'tests',       label: '测试',         icon: '🧪',  order: 14 },
  { key: 'docs',        label: '文档',         icon: '📖',  order: 15 },
  { key: 'other',       label: '其他',         icon: '📦',  order: 99 },
];

function cleanPath(raw: string): string {
  let s = raw.replace(/[`'"*]/g, '');
  s = s.replace(/^-\s*/gm, '');
  for (const sep of ['（', '(', '：']) {
    const i = s.indexOf(sep);
    if (i >= 0) { s = s.slice(0, i); break; }
  }
  return s.trim();
}

const PATH_RULES: [RegExp, string][] = [
  [/^src\/cli/,                        'cli'],
  [/^src\/core\/slice/,                'core-slice'],
  [/^src\/core\/policy/,               'core-policy'],
  [/^src\/core\/gate/,                 'core-gate'],
  [/^src\/core\/events/,               'core-events'],
  [/^src\/core\/stall/,                'core-stall'],
  [/^src\/core\/sched/,                'core-sched'],
  [/^src\/core\//,                     'core-other'],
  [/^src\/adapters/,                   'adapters'],
  [/^src\/llm/,                        'llm'],
  [/^src\/hook/,                       'hook'],
  [/^contracts\//,                     'contracts'],
  [/^specs\//,                         'specs'],
  [/^tests\//,                         'tests'],
  [/^docs\//,                          'docs'],
];

function detectArea(writes: string[]): string {
  for (const raw of writes) {
    const w = cleanPath(raw);
    for (const [re, key] of PATH_RULES) { if (re.test(w)) return key; }
  }
  return 'other';
}

function areaDef(key: string) {
  return AREA_DEFS.find((a) => a.key === key) ?? { key, label: key, icon: '📦', order: 99 };
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SliceData {
  id: string; title: string; state: string;
  stallClass: string | null; autoResolved: number;
  writes: string[]; type: SliceType; area: string;
  createdAt: string; updatedAt: string;
  planId: string; planTitle: string;
  version: string; module: string;
}

interface PlanSummary {
  planId: string; title: string;
  versions: { name: string; status: string; slices: SliceData[] }[];
}

interface EventInfo { ts: string; type: string; slice: string; actor: string; }

// ─── Collect ─────────────────────────────────────────────────────────────────

function collectSlices(): Map<string, SliceData> {
  const dir = join(ZELTO_DIR, 'slices');
  const map = new Map<string, SliceData>();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      const id = d.id ?? f.replace('.json', '');
      const writes: string[] = d.writes ?? [];
      map.set(id, {
        id, title: d.title ?? '', state: d.state ?? 'unknown',
        stallClass: d.stall?.class ?? null, autoResolved: d.stall?.autoResolved ?? 0,
        writes, type: detectSliceType(writes), area: detectArea(writes),
        createdAt: d.createdAt ?? '', updatedAt: d.updatedAt ?? '',
        planId: '', planTitle: '', version: '', module: '',
      });
    } catch { /* skip */ }
  }
  return map;
}

function buildPlans(sliceMap: Map<string, SliceData>): PlanSummary[] {
  const dir = join(ZELTO_DIR, 'versions');
  if (!existsSync(dir)) return [];
  const plans: PlanSummary[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      const planId = f.replace('.json', '');
      const plan: PlanSummary = { planId, title: d.title ?? f, versions: [] };
      for (const v of d.versions ?? []) {
        const vi = { name: v.version, status: v.status ?? 'planned', slices: [] as SliceData[] };
        for (const s of v.slices ?? []) {
          const slice = sliceMap.get(s.id);
          if (slice) {
            slice.planId = planId; slice.planTitle = plan.title;
            slice.version = v.version; slice.module = s.module ?? '';
            vi.slices.push(slice);
          }
        }
        plan.versions.push(vi);
      }
      plans.push(plan);
    } catch { /* skip */ }
  }
  return plans;
}

function collectRecentEvents(limit = 50): EventInfo[] {
  const dir = join(ZELTO_DIR, 'events');
  if (!existsSync(dir)) return [];
  const all: EventInfo[] = [];
  for (const sd of readdirSync(dir, { withFileTypes: true })) {
    if (!sd.isDirectory()) continue;
    const f = join(dir, sd.name, 'events.jsonl');
    if (!existsSync(f)) continue;
    try {
      for (const line of readFileSync(f, 'utf-8').split('\n').filter(Boolean).slice(-10)) {
        try { const e = JSON.parse(line); all.push({ ts: e.ts, type: e.type, slice: e.slice, actor: e.actor }); }
        catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  all.sort((a, b) => (a.ts > b.ts ? -1 : 1));
  return all.slice(0, limit);
}

/**
 * 把时长说成人话。
 *
 * 「1016m」没人读得懂 —— 看板上的每个数字都要能被扫一眼读出来。
 */
function fmtAge(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return '刚刚';
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 60 * 24) {
    const h = Math.floor(minutes / 60);
    const m = Math.floor(minutes % 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(minutes / (60 * 24));
  const h = Math.floor((minutes % (60 * 24)) / 60);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

// ─── Action Recommendations ──────────────────────────────────────────────────

interface ActionItem {
  priority: number;
  command: string;
  reason: string;
}

function computeActions(
  slices: SliceData[], plans: PlanSummary[], releases: ReleaseDef[],
): ActionItem[] {
  const actions: ActionItem[] = [];

  // Stalled slices → resume
  for (const s of slices) {
    if (s.stallClass) {
      const stallAge = s.updatedAt ? Math.floor((Date.now() - new Date(s.updatedAt).getTime()) / 60000) : 0;
      const ageStr = stallAge > 0 ? ` (${fmtAge(stallAge)})` : '';
      actions.push({ priority: 1, command: `zelto resume ${s.id}`, reason: `⚠️ Stalled: ${s.stallClass}${ageStr}` });
    }
  }

  // Plans with completed slices that could be delivered
  for (const plan of plans) {
    for (const v of plan.versions) {
      const total = v.slices.length;
      const done = v.slices.filter((s) => s.state === 'completed').length;
      if (total > 0 && done === total) {
        actions.push({ priority: 2, command: `zelto version deliver ${v.name}`, reason: `📦 Version ${v.name} all ${total} slices completed` });
      }
      // Plans with some progress but stalled
      const stalled = v.slices.filter((s) => s.stallClass).length;
      if (stalled > 0 && done < total) {
        actions.push({ priority: 2, command: `zelto version status ${v.name}`, reason: `📋 Version ${v.name}: ${done}/${total} done, ${stalled} stalled` });
      }
    }
  }

  // 待签字队列 —— 真源是 `.zelto/locks/sign-*.json`（与 zelto inbox / next / merge 同源）。
  //
  // 这里原来读的是 `.zelto/inbox`：那个目录根本不存在（签字请求落在 locks 下），
  // 于是「有待签字」这条提示永远不会出现 —— 一道永远敞开的门。
  const pendingSigns = readPendingSigns();
  if (pendingSigns.length > 0) {
    const oldest = pendingSigns[0];
    const ageMin = oldest.requestedAt
      ? Math.floor((Date.now() - new Date(oldest.requestedAt).getTime()) / 60000)
      : 0;
    const ageStr = ageMin > 0 ? ` (最久一条等 ${fmtAge(ageMin)})` : '';
    actions.push({
      priority: 3,
      command: 'zelto inbox',
      reason: `📝 ${pendingSigns.length} pending approval(s)${ageStr}`,
    });
  }

  // Auto-resolved stalls that haven't been resumed
  const autoResolved = slices.filter((s) => s.autoResolved > 0 && !s.stallClass);
  if (autoResolved.length > 0) {
    actions.push({ priority: 3, command: `zelto stall --auto-resolved`, reason: `🔄 ${autoResolved.length} slice(s) with auto-retry history` });
  }

  // Running slices (check for long-running)
  const running = slices.filter((s) => s.state === 'running');
  for (const s of running) {
    if (s.updatedAt) {
      const elapsed = Math.floor((Date.now() - new Date(s.updatedAt).getTime()) / 60000);
      if (elapsed > 10) {
        actions.push({ priority: 4, command: `zelto stall ${s.id}`, reason: `⏱️ ${s.id} running ${elapsed}m — check status` });
      }
    }
  }

  return actions.sort((a, b) => a.priority - b.priority);
}

// ─── TTY Render ─────────────────────────────────────────────────────────────

function renderTty(
  slices: SliceData[], plans: PlanSummary[], releases: ReleaseDef[],
  events: EventInfo[], costMap: Map<string, SliceCost>, budgetLimit: number,
): string {
  const stalled = slices.filter((s) => s.stallClass);
  const running = slices.filter((s) => s.state === 'running');
  const stateCnt: Record<string, number> = {};
  for (const s of slices) { stateCnt[s.state] = (stateCnt[s.state] ?? 0) + 1; }

  const totals = sumCosts(costMap, slices.length);

  const lines: string[] = [];
  const h = (s: string) => colors.bold(colors.cyan(s));

  lines.push('');
  lines.push(`  ${h('📊 zelto 工程状态')}  ${colors.dim(new Date().toLocaleString())}`);
  lines.push('');

  // Summary bar
  const summaryParts = [
    `Slices: ${colors.bold(String(slices.length))}`,
    `Running: ${colors.blue(String(stateCnt['running'] ?? 0))}`,
    `Stalled: ${colors.red(String(stalled.length))}`,
    `Completed: ${colors.green(String(stateCnt['completed'] ?? 0))}`,
    `Cost: ${colors.magenta(fmtCost(totals.totalCost))}`,
    `Tokens: ${colors.magenta(fmtTokens(totals.totalTokens))}`,
  ];
  lines.push(`  ${summaryParts.join('  ·  ')}`);
  lines.push('');

  // State bar (compact)
  const stateOrder = ['running', 'frozen', 'completed', 'draft', 'clarifying', 'abandoned'];
  const barParts = stateOrder
    .map((st) => { const c = stateCnt[st] ?? 0; return c > 0 ? `${ST_ICON[st] ?? '❔'} ${c}` : ''; })
    .filter(Boolean);
  if (barParts.length > 0) lines.push(`  ${colors.dim('States:')}  ${barParts.join('  ')}`);
  lines.push('');

  // Stalled list
  if (stalled.length > 0) {
    lines.push(`  ${colors.red(colors.bold(`⚠️  Stalled (${stalled.length})`))}`);
    for (const s of stalled) {
      const loc = [s.planTitle, s.version, s.module].filter(Boolean).join('/') || '';
      const locStr = loc ? colors.dim(` (${loc})`) : '';
      lines.push(`    ${colors.red('❌')} ${colors.bold(s.id)} ${colors.yellow(s.stallClass!)}${locStr}`);
      lines.push(`       ${colors.dim('→')} zelto resume ${s.id}`);
    }
    lines.push('');
  }

  // Running list
  if (running.length > 0) {
    lines.push(`  ${colors.blue(colors.bold(`🔄 Running (${running.length})`))}`);
    for (const s of running) {
      const elapsed = s.updatedAt ? Math.floor((Date.now() - new Date(s.updatedAt).getTime()) / 1000) : 0;
      const elapsedStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
      lines.push(`    ${colors.blue('🔄')} ${colors.bold(s.id)} ${colors.dim(elapsedStr)}`);
    }
    lines.push('');
  }

  // Release progress
  if (releases.length > 0) {
    lines.push(`  ${h('📌 版本路线图')}`);
    for (const r of releases) {
      const relSlices: SliceData[] = [];
      for (const pid of r.plans) {
        const p = plans.find((pl) => pl.planId === pid);
        if (p) for (const v of p.versions) relSlices.push(...v.slices);
      }
      const total = relSlices.length;
      const done = relSlices.filter((s) => s.state === 'completed').length;
      const sCnt = relSlices.filter((s) => s.stallClass).length;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const colorFn = pct === 100 ? colors.green : sCnt > 0 ? colors.red : colors.blue;
      lines.push(`    ${colors.bold(r.version)} ${colors.dim(r.title)}  ${colorFn(`${done}/${total} ${pct}%`)}${sCnt > 0 ? colors.red(` ⚠${sCnt}`) : ''}`);
    }
    lines.push('');
  }

  // Actions
  const actions = computeActions(slices, plans, releases);
  if (actions.length > 0) {
    lines.push(`  ${h('📋 Next Actions')}`);
    for (const a of actions) {
      const pfx = a.priority === 1 ? colors.red('⚠') : a.priority === 2 ? colors.blue('▶') : colors.dim('·');
      lines.push(`    ${pfx} ${colors.bold(a.command)}  ${colors.dim(`# ${a.reason}`)}`);
    }
    lines.push('');
  }

  // Cost & tokens —— agent 干活 vs 规划期草稿，两笔账分开看（ADR-035）
  if (totals.measuredSlices > 0) {
    lines.push(`  ${h('💰 成本与 Token')}`);
    lines.push(`    ${colors.dim('Agent 执行')}  ${colors.bold(fmtCost(totals.agentCost))}  ${colors.cyan(`${fmtTokens(totals.agentTokens)} tokens`)}  ${colors.dim(`(in ${fmtTokens(totals.agentInputTokens)} / out ${fmtTokens(totals.agentOutputTokens)}) · ${totals.agentCalls} 次会话`)}`);
    lines.push(`    ${colors.dim('规划期 LLM')}  ${colors.bold(fmtCost(totals.llmCost))}  ${colors.cyan(`${fmtTokens(totals.llmTokens)} tokens`)}  ${colors.dim(`(in ${fmtTokens(totals.llmPromptTokens)} / out ${fmtTokens(totals.llmCompletionTokens)}) · ${totals.llmCalls} 次调用`)}`);
    const measured = `测到用量 ${totals.measuredSlices}/${slices.length} 片`;
    const unmeasured = totals.unmeasuredSlices > 0 ? ` · ${totals.unmeasuredSlices} 片未测到` : '';
    lines.push(`    ${colors.dim('Token 合计')}  ${colors.bold(fmtTokens(totals.totalTokens))}  ${colors.dim(measured + unmeasured)}`);

    // 最贵的一片 vs 每片上限 —— 预算闸门离合闸还有多远
    let priciest: { id: string; cost: number } | null = null;
    for (const [id, c] of costMap) {
      if (!priciest || c.totalCost > priciest.cost) priciest = { id, cost: c.totalCost };
    }
    if (priciest) {
      const pct = Number.isFinite(budgetLimit) && budgetLimit > 0
        ? Math.round((priciest.cost / budgetLimit) * 100)
        : null;
      const color = pct === null ? colors.dim : pct >= 100 ? colors.red : pct >= 70 ? colors.yellow : colors.green;
      const pctStr = pct === null ? '' : ` (${pct}%)`;
      lines.push(`    ${colors.dim('每片上限')}  ${colors.bold(fmtLimit(budgetLimit))}  ${colors.dim('最贵一片')} ${colors.bold(priciest.id)} ${color(fmtCost(priciest.cost) + pctStr)}`);
    }
    lines.push('');
  }

  // Recent events —— 事件流是追溯的底座，TTY 视图里不能缺席
  if (events.length > 0) {
    lines.push(`  ${h('📜 最近事件')}`);
    for (const e of events.slice(0, 8)) {
      const ts = e.ts ? e.ts.replace('T', ' ').slice(5, 16) : '';
      lines.push(`    ${colors.dim(ts)}  ${colors.magenta(e.type)}  ${colors.dim(e.slice)}`);
    }
    lines.push('');
  }

  // Summary line
  lines.push(`  ${colors.dim('Generated by zelto dashboard')}  ${colors.dim('Run zelto dashboard --tty for this view')}`);
  lines.push('');

  return lines.join('\n');
}

// ─── JSON Render ────────────────────────────────────────────────────────────

function renderJson(
  slices: SliceData[], plans: PlanSummary[], releases: ReleaseDef[],
  events: EventInfo[], costMap: Map<string, SliceCost>, budgetLimit: number,
): string {
  const stalled = slices.filter((s) => s.stallClass);
  const running = slices.filter((s) => s.state === 'running');
  const stateCnt: Record<string, number> = {};
  const typeCnt: Record<string, number> = {};
  for (const s of slices) { stateCnt[s.state] = (stateCnt[s.state] ?? 0) + 1; typeCnt[s.type] = (typeCnt[s.type] ?? 0) + 1; }

  const totals = sumCosts(costMap, slices.length);

  const data = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalSlices: slices.length,
      stateCounts: stateCnt,
      typeCounts: typeCnt,
      stalledCount: stalled.length,
      runningCount: running.length,
      releaseCount: releases.length,
      planCount: plans.length,
    },
    cost: {
      totalCostUsd: totals.totalCost,
      agentCostUsd: totals.agentCost,
      llmCostUsd: totals.llmCost,
      agentCalls: totals.agentCalls,
      llmCalls: totals.llmCalls,
      totalTokens: totals.totalTokens,
      agentTokens: totals.agentTokens,
      agentInputTokens: totals.agentInputTokens,
      agentOutputTokens: totals.agentOutputTokens,
      llmTokens: totals.llmTokens,
      llmPromptTokens: totals.llmPromptTokens,
      llmCompletionTokens: totals.llmCompletionTokens,
      budgetLimitUsdPerSlice: Number.isFinite(budgetLimit) ? budgetLimit : null,
      budgetUnlimited: !Number.isFinite(budgetLimit),
      slicesWithUsage: totals.measuredSlices,
      slicesWithoutUsage: totals.unmeasuredSlices,
    },
    slices: slices.map((s) => {
      const c = costMap.get(s.id);
      return {
        id: s.id,
        title: s.title,
        state: s.state,
        type: s.type,
        area: s.area,
        version: s.version,
        module: s.module,
        updatedAt: s.updatedAt,
        costUsd: c ? c.totalCost : null,
        tokens: c ? c.totalTokens : null,
        agentTokens: c ? c.agentTokens : null,
        llmTokens: c ? c.llmTokens : null,
        agentCalls: c ? c.agentCalls : 0,
        llmCalls: c ? c.llmCalls : 0,
      };
    }),
    topByTokens: topSlicesByTokens(costMap, 10).map(({ sliceId, cost }) => ({
      sliceId,
      tokens: cost.totalTokens,
      agentTokens: cost.agentTokens,
      llmTokens: cost.llmTokens,
      costUsd: cost.totalCost,
    })),
    recentEvents: events.slice(0, 50),
    stalled: stalled.map((s) => ({
      id: s.id, title: s.title, stallClass: s.stallClass,
      autoResolved: s.autoResolved, area: s.area,
      plan: s.planTitle, version: s.version, module: s.module,
      updatedAt: s.updatedAt,
      stalledMinutes: s.updatedAt
        ? Math.floor((Date.now() - new Date(s.updatedAt).getTime()) / 60000)
        : null,
    })),
    running: running.map((s) => ({
      id: s.id, title: s.title, area: s.area, updatedAt: s.updatedAt,
    })),
    releases: releases.map((r) => {
      const relSlices: SliceData[] = [];
      for (const pid of r.plans) {
        const p = plans.find((pl) => pl.planId === pid);
        if (p) for (const v of p.versions) relSlices.push(...v.slices);
      }
      return {
        version: r.version, title: r.title, status: r.status,
        totalSlices: relSlices.length,
        completedSlices: relSlices.filter((s) => s.state === 'completed').length,
        stalledSlices: relSlices.filter((s) => s.stallClass).length,
      };
    }),
    plans: plans.map((p) => ({
      planId: p.planId, title: p.title,
      versions: p.versions.map((v) => ({
        name: v.name, status: v.status,
        totalSlices: v.slices.length,
        completedSlices: v.slices.filter((s) => s.state === 'completed').length,
      })),
    })),
    actions: computeActions(slices, plans, releases),
  };

  return JSON.stringify(data, null, 2);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * HTML 文本转义。
 *
 * 看板里的切片标题、事件 actor、事件类型都来自外部写入的文件（事件流是
 * append-only 的，任何进程都能往里追加）。直接拼进 HTML 就会被浏览器当成
 * 标记解析 —— 这是真的注入面，不是什么理论风险。
 */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ST_ICON: Record<string, string> = {
  draft: '📝', clarifying: '❓', frozen: '❄️', running: '🔄', completed: '✅', abandoned: '🗑️',
};
function sIcon(s: string) { return ST_ICON[s] ?? '❔'; }

const TY_ICON: Record<string, string> = { code: '💻', docs: '📄', config: '⚙️', refactor: '♻️' };
function tIcon(t: string) { return TY_ICON[t] ?? '📦'; }

function stallColor(c: string | null): string {
  if (!c) return '';
  return ['cognitive_stuck','plan_gate','budget_exhausted','gate_retry'].includes(c) ? '#ff4444' : '#ffaa00';
}

function isDirModule(name: string): boolean {
  return /^(src|tests|docs|specs|contracts)\//.test(name);
}

function statusColor(st: string): string {
  const m: Record<string, string> = { completed: '#3fb950', in_progress: '#58a6ff', planned: '#8b949e', cancelled: '#484f58', delivered: '#3fb950', active: '#58a6ff' };
  return m[st] ?? '#8b949e';
}

function statusLabel(st: string): string {
  const m: Record<string, string> = { completed: '✅ 已完成', in_progress: '🔄 进行中', planned: '📋 计划中', cancelled: '🗑️ 已取消' };
  return m[st] ?? st;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderHtml(
  slices: SliceData[], plans: PlanSummary[], releases: ReleaseDef[],
  events: EventInfo[], watchMode: boolean, costMap: Map<string, SliceCost>,
  budgetLimit: number,
): string {
  const stalled = slices.filter((s) => s.stallClass);
  const stateCnt: Record<string, number> = {};
  const typeCnt: Record<string, number> = {};
  for (const s of slices) { stateCnt[s.state] = (stateCnt[s.state] ?? 0) + 1; typeCnt[s.type] = (typeCnt[s.type] ?? 0) + 1; }

  // Build lookup: planId → plan
  const planMap = new Map(plans.map((p) => [p.planId, p]));

  // Cost calculations —— 与 TTY / JSON 共用同一份口径（dashboard-cost.ts）
  const totals = sumCosts(costMap, slices.length);
  const actions = computeActions(slices, plans, releases);

  // ── Summary ──────────────────────────────────────────────────────────────────
  const summary = `
<div class="g">
  <div class="c"><div class="n">${slices.length}</div><div class="l">Slices</div></div>
  <div class="c"><div class="n">${releases.length}</div><div class="l">Releases</div></div>
  <div class="c"><div class="n">${stateCnt['running'] ?? 0}</div><div class="l">🔄 Running</div></div>
  <div class="c st"><div class="n">${stalled.length}</div><div class="l">⚠️ Stalled</div></div>
  <div class="c" style="border-color:#58a6ff66"><div class="n">${fmtCost(totals.totalCost)}</div><div class="l">💰 Total cost</div></div>
  <div class="c" style="border-color:#d2a8ff66"><div class="n">${fmtTokens(totals.totalTokens)}</div><div class="l">🧮 Total tokens</div></div>
</div>`;

  const stateOrder = ['running','frozen','completed','draft','clarifying','abandoned'];
  const stateBar = stateOrder.map((st) => {
    const c = stateCnt[st] ?? 0;
    if (c === 0) return '';
    return `<div class="brs b-${st}" style="width:${((c/slices.length)*100).toFixed(0)}%">${sIcon(st)} ${c}</div>`;
  }).filter(Boolean).join('');

  const typeBar = (['code','docs','config','refactor'] as const).map((t) => {
    const c = typeCnt[t] ?? 0;
    if (c === 0) return '';
    return `<div class="brs b-${t}" style="width:${((c/slices.length)*100).toFixed(0)}%">${tIcon(t)} ${c}</div>`;
  }).filter(Boolean).join('');

  // ══════════════════════════════════════════════════════════════════════════════
  // LAYER 1 — Stalled
  // ══════════════════════════════════════════════════════════════════════════════
  const stalledLayer = stalled.length > 0 ? `
<div class="lx">
  <h2>⚠️ Stalled <span class="hc">${stalled.length}</span></h2>
  ${stalled.map((s) => {
    const loc = [s.planTitle, s.version, s.module].filter(Boolean).join(' / ') || areaDef(s.area).label;
    const age = s.updatedAt ? Math.floor((Date.now() - new Date(s.updatedAt).getTime()) / 60000) : 0;
    const ageStr = age > 0 ? ` · ${fmtAge(age)}` : '';
    return `<div class="li"><span class="ld" style="background:${stallColor(s.stallClass)}"></span><span class="lid">${esc(s.id)}</span><span class="lcls">${esc(s.stallClass)}</span><span class="lloc">${esc(loc + ageStr)}</span><code>zelto resume ${esc(s.id)}</code></div>`;
  }).join('')}
</div>` : '';

  // ══════════════════════════════════════════════════════════════════════════════
  // LAYER 1.5 — Cost & tokens
  // ══════════════════════════════════════════════════════════════════════════════
  // 两笔账分开摆：agent 干活的钱 vs 规划期草稿的钱。混在一起看，
  // 就分不清「是 agent 太贵」还是「是规划层反复重写规格」（ADR-035 §3.3）。
  let priciest: { id: string; cost: number } | null = null;
  for (const [id, c] of costMap) {
    if (!priciest || c.totalCost > priciest.cost) priciest = { id, cost: c.totalCost };
  }
  const limitPct = (cost: number): number | null =>
    Number.isFinite(budgetLimit) && budgetLimit > 0 ? Math.round((cost / budgetLimit) * 100) : null;
  const pctColor = (pct: number | null): string =>
    pct === null ? '#8b949e' : pct >= 100 ? '#ff7b72' : pct >= 70 ? '#d29922' : '#3fb950';

  const topTokens = topSlicesByTokens(costMap, 8);
  const topRows = topTokens
    .map(({ sliceId, cost }) => {
      const pct = limitPct(cost.totalCost);
      return `<tr><td class="eet">${esc(sliceId)}</td><td>${fmtTokens(cost.totalTokens)}</td><td class="etm">${fmtTokens(cost.agentInputTokens)}</td><td class="etm">${fmtTokens(cost.agentOutputTokens)}</td><td>${fmtCost(cost.totalCost)}</td><td style="color:${pctColor(pct)}">${pct === null ? '—' : `${pct}%`}</td></tr>`;
    })
    .join('');

  const costLayer =
    totals.measuredSlices > 0
      ? `
<h2 class="sh">💰 成本与 Token <span class="hc">agent 执行 vs 规划期草稿</span></h2>
<div class="cost">
  <div class="cost-card">
    <div class="cl">Agent 执行</div>
    <div class="cv">${fmtCost(totals.agentCost)}</div>
    <div class="cs">${fmtTokens(totals.agentTokens)} tokens</div>
    <div class="cs">in ${fmtTokens(totals.agentInputTokens)} / out ${fmtTokens(totals.agentOutputTokens)}</div>
    <div class="cs">${totals.agentCalls} 次 agent 会话</div>
  </div>
  <div class="cost-card">
    <div class="cl">规划期 LLM</div>
    <div class="cv">${fmtCost(totals.llmCost)}</div>
    <div class="cs">${fmtTokens(totals.llmTokens)} tokens</div>
    <div class="cs">in ${fmtTokens(totals.llmPromptTokens)} / out ${fmtTokens(totals.llmCompletionTokens)}</div>
    <div class="cs">${totals.llmCalls} 次 LLM 调用</div>
  </div>
  <div class="cost-card">
    <div class="cl">Token 合计</div>
    <div class="cv">${fmtTokens(totals.totalTokens)}</div>
    <div class="cs">${totals.measuredSlices}/${slices.length} 片测到用量</div>
    ${totals.unmeasuredSlices > 0 ? `<div class="cs warn">${totals.unmeasuredSlices} 片未测到用量</div>` : ''}
  </div>
  <div class="cost-card">
    <div class="cl">每片预算上限</div>
    <div class="cv">${fmtLimit(budgetLimit)}</div>
    ${priciest ? `<div class="cs">最贵一片 ${esc(priciest.id)} ${fmtCost(priciest.cost)}${limitPct(priciest.cost) === null ? '' : ` · ${limitPct(priciest.cost)}%`}</div>` : '<div class="cs">—</div>'}
  </div>
</div>
${topRows ? `<h2 class="sh">🔥 Token 消耗 Top <span class="hc">${topTokens.length} 片</span></h2>
<table>
<thead><tr><th>Slice</th><th>Tokens</th><th>Agent in</th><th>Agent out</th><th>Cost</th><th>占上限</th></tr></thead>
<tbody>${topRows}</tbody>
</table>` : ''}`
      : '';

  // ══════════════════════════════════════════════════════════════════════════════
  // LAYER 2 — Releases
  // ══════════════════════════════════════════════════════════════════════════════
  const releaseLayer = releases.length > 0 ? `
<h2 class="sh">📌 版本路线图 <span class="hc">${releases.length} releases</span></h2>
<div class="rl-grid">
${releases.map((r) => {
  // Collect all slices across all plans in this release
  const relSlices: SliceData[] = [];
  const unresolvedPlans: string[] = [];
  for (const pid of r.plans) {
    const p = planMap.get(pid);
    if (p) {
      for (const v of p.versions) relSlices.push(...v.slices);
    } else {
      unresolvedPlans.push(pid);
    }
  }
  const total = relSlices.length;
  const done = relSlices.filter((s) => s.state === 'completed').length;
  const sCnt = relSlices.filter((s) => s.stallClass).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : (r.status === 'completed' ? 100 : 0);

  // Per-release cost
  let relCost = 0;
  for (const s of relSlices) { const c = costMap.get(s.id); if (c) relCost += c.totalCost; }

  // Per-module breakdown
  const modMap = new Map<string, [number, number, number]>(); // [completed, total, cost]
  for (const s of relSlices) {
    const mk = s.module && !isDirModule(s.module) ? s.module : areaDef(s.area).label;
    if (!modMap.has(mk)) modMap.set(mk, [0, 0, 0]);
    const a = modMap.get(mk)!;
    a[1]++;
    if (s.state === 'completed') a[0]++;
    const sc = costMap.get(s.id);
    if (sc) a[2] += sc.totalCost;
  }

  const moduleLines = [...modMap.entries()]
    .sort((a, b) => (a[0] > b[0] ? 1 : -1))
    .map(([mod, [d, t, c]]) => {
      const mpct = Math.round((d / t) * 100);
      const icon = mpct === 100 ? '✅' : mpct > 0 ? '🔄' : '⏳';
      const costStr = c > 0 ? ` · ${fmtCost(c)}` : '';
      return `<span class="rl-mod">${icon} ${esc(mod)} <span class="rl-mod-stat">${d}/${t}${costStr}</span></span>`;
    }).join('');

  const bg = r.status === 'completed' ? '#1a2e1a' : r.status === 'in_progress' ? '#1a1f2e' : '#161b22';
  const border = r.status === 'in_progress' ? '1px solid #58a6ff66' : '1px solid #30363d';

  return `<div class="rl-card" style="background:${bg};border:${border}">
    <div class="rl-head">
      <span class="rl-ver">${esc(r.version)}</span>
      <span class="rl-title">${esc(r.title)}</span>
      <span class="rl-status" style="color:${statusColor(r.status)}">${statusLabel(r.status)}</span>
    </div>
    <div class="rl-desc">${esc(r.description)}</div>
    <div class="rl-bar-wrap"><span class="rl-bar" style="width:${pct}%;background:${pct===100?'#3fb950':sCnt>0?'#ff7b72':'#58a6ff'}"></span></div>
    <div class="rl-bar-label">${done}/${total} slices${sCnt ? ` · ⚠ ${sCnt} stalled` : ''}${total > 0 ? ` · ${pct}%` : ''}${relCost > 0 ? ` · ${fmtCost(relCost)}` : ''}</div>
    <div class="rl-mods">${moduleLines || '<span class="rl-mod-stat">(no slices assigned)</span>'}</div>
    ${unresolvedPlans.length > 0 ? `<div class="rl-warn">⚠ ${esc(unresolvedPlans.join(', '))} not found</div>` : ''}
  </div>`;
}).join('')}
</div>` : '';

  // ══════════════════════════════════════════════════════════════════════════════
  // LAYER 3 — Version Plans
  // ══════════════════════════════════════════════════════════════════════════════
  const planLayer = plans.length > 0 ? `
<h2 class="sh">📋 版本计划 <span class="hc">${plans.length} plans</span></h2>
${plans.map((plan) => {
  const versionsHtml = plan.versions.map((v) => {
    const total = v.slices.length;
    const done = v.slices.filter((s) => s.state === 'completed').length;
    const sCnt = v.slices.filter((s) => s.stallClass).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const modMap = new Map<string, SliceData[]>();
    for (const s of v.slices) {
      const mk = s.module && !isDirModule(s.module) ? s.module : '';
      if (!modMap.has(mk)) modMap.set(mk, []);
      modMap.get(mk)!.push(s);
    }

    const moduleHtml = [...modMap.entries()].map(([modName, modSlices]) => {
      const rows = modSlices.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
        .map((s) => {
          const stallTag = s.stallClass ? `<span class="st" style="background:${stallColor(s.stallClass)}">⚠ ${esc(s.stallClass)}</span>` : '';
          const sc = costMap.get(s.id);
          const costTag = sc && sc.totalCost > 0 ? `<span class="ct">${fmtCost(sc.totalCost)}</span>` : '';
          return `<div class="vr"><span class="vtic">${tIcon(s.type)}</span><span class="vsic">${sIcon(s.state)}</span><span class="vid">${esc(s.id)}</span><span class="vtl">${esc(s.title)}</span><span class="badge badge-${s.state}">${s.state}</span>${costTag}${stallTag}</div>`;
        }).join('');
      if (!modName) return rows;
      return `<div class="vm"><div class="vmt">${esc(modName)} <span class="vmc">${modSlices.length}</span></div>${rows}</div>`;
    }).join('');

    return `<details class="vd" ${v.status === 'active' ? 'open' : ''}>
      <summary class="vs"><span class="vv">${esc(v.name)}</span><span class="vtg" style="background:${statusColor(v.status)}">${esc(v.status)}</span><span class="vpb"><span class="vpf" style="width:${pct}%;background:${pct===100?'#3fb950':sCnt>0?'#ff7b72':'#58a6ff'}"></span></span><span class="vpct">${done}/${total}${sCnt ? ` ⚠${sCnt}` : ''}</span></summary>
      <div class="vb">${moduleHtml}</div>
    </details>`;
  }).join('');

  return `<div class="pc"><div class="pch"><span class="pctt">${esc(plan.title)}</span><span class="pcm">${plan.versions.length} versions · ${plan.versions.reduce((a, v) => a + v.slices.length, 0)} slices</span></div>${versionsHtml}</div>`;
}).join('')}` : '';

  // ══════════════════════════════════════════════════════════════════════════════
  // LAYER 4 — Code Areas (collapsed)
  // ══════════════════════════════════════════════════════════════════════════════
  const areaMap = new Map<string, Map<string, SliceData[]>>();
  for (const s of slices) {
    if (!areaMap.has(s.area)) areaMap.set(s.area, new Map());
    const mk = s.module && !isDirModule(s.module) ? s.module : '';
    const mm = areaMap.get(s.area)!;
    if (!mm.has(mk)) mm.set(mk, []);
    mm.get(mk)!.push(s);
  }
  const sortedAreas = [...areaMap.entries()].sort((a, b) => areaDef(a[0]).order - areaDef(b[0]).order);

  const areaLayer = sortedAreas.length > 0 ? `
<h2 class="sh">🏗️ 代码结构 <span class="hc">${sortedAreas.length} areas</span></h2>
${sortedAreas.map(([areaKey, modMap]) => {
  const ad = areaDef(areaKey);
  const allSlices = [...modMap.values()].flat();
  const done = allSlices.filter((s) => s.state === 'completed').length;
  const sCnt = allSlices.filter((s) => s.stallClass).length;
  const pct = Math.round((done / allSlices.length) * 100);

  const modBlocks = [...modMap.entries()].map(([modName, modSlices]) => {
    const sorted = [...modSlices].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    const rows = sorted.map((s) => {
      const stallTag = s.stallClass ? `<span class="st" style="background:${stallColor(s.stallClass)}">⚠ ${esc(s.stallClass)}</span>` : '';
      const verTag = s.version ? `<span class="vt">${esc(s.version)}</span>` : '';
      const sc = costMap.get(s.id);
      const costTag = sc && sc.totalCost > 0 ? `<span class="ct">${fmtCost(sc.totalCost)}</span>` : '';
      return `<div class="ar"><span class="atic">${tIcon(s.type)}</span><span class="asic">${sIcon(s.state)}</span><span class="aid">${esc(s.id)}</span><span class="atl">${esc(s.title)}</span><span class="badge badge-${s.state}">${s.state}</span>${verTag}${costTag}${stallTag}</div>`;
    }).join('');
    if (!modName) return rows;
    return `<div class="am"><div class="amt">${esc(modName)} <span class="amc">${modSlices.length}</span></div>${rows}</div>`;
  }).join('');

  return `<details class="ad"><summary class="as"><span class="ai">${ad.icon}</span><span class="al">${ad.label}</span><span class="asc">${allSlices.length}</span><span class="apb"><span class="apf" style="width:${pct}%;background:${pct===100?'#3fb950':sCnt>0?'#ff7b72':'#58a6ff'}"></span></span><span class="apc">${done}/${allSlices.length}${sCnt ? ` ⚠${sCnt}` : ''}</span></summary><div class="abd">${modBlocks}</div></details>`;
}).join('')}` : '';

  // ══════════════════════════════════════════════════════════════════════════════
  // LAYER 5 — Events
  // ══════════════════════════════════════════════════════════════════════════════
  const eventRows = events.map((e) =>
    `<tr><td class="etm">${esc(new Date(e.ts).toLocaleString())}</td><td><span class="eet">${esc(e.type)}</span></td><td>${esc(e.slice)}</td><td>${esc(e.actor)}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${watchMode ? '<meta http-equiv="refresh" content="3">' : ''}
<title>zelto Dashboard</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px;max-width:1200px;margin:0 auto}
  h1{font-size:22px;font-weight:600;display:flex;align-items:center;gap:10px;margin-bottom:2px}
  h1 small{font-size:13px;font-weight:400;color:#8b949e}
  .sub{color:#8b949e;font-size:12px;margin-bottom:18px}
  .sh{font-size:14px;font-weight:600;margin:20px 0 10px;color:#e6edf3;display:flex;align-items:center;gap:8px}
  .hc{font-size:11px;font-weight:400;color:#8b949e}
  .g{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
  .c{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;flex:1;min-width:80px}
  .c .n{font-size:24px;font-weight:700}
  .c .l{font-size:11px;color:#8b949e;margin-top:2px}
  .c.st .n{color:#ff7b72}
  /* Cost & tokens */
  .cost{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-bottom:14px}
  .cost-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 14px}
  .cl{font-size:11px;color:#8b949e}
  .cv{font-size:22px;font-weight:700;margin:2px 0 6px;color:#e6edf3}
  .cs{font-size:10px;color:#8b949e;line-height:1.6}
  .cs.warn{color:#d29922}
  .br{display:flex;height:24px;border-radius:5px;overflow:hidden;margin-bottom:12px}
  .brs{display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#fff;gap:2px}
  .b-running,.brs.b-running{background:#1f6feb}.b-frozen,.brs.b-frozen{background:#58a6ff}.b-completed,.brs.b-completed{background:#238636}
  .b-draft,.brs.b-draft{background:#8957e5}.b-clarifying,.brs.b-clarifying{background:#9e6a03}.b-abandoned,.brs.b-abandoned{background:#484f58}
  .b-code,.brs.b-code{background:#1f6feb}.b-docs,.brs.b-docs{background:#8957e5}.b-config,.brs.b-config{background:#9e6a03}.b-refactor,.brs.b-refactor{background:#3fb950}
  .lg{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:#8b949e;margin-bottom:14px}
  .lg .sp{color:#30363d;margin:0 2px}
  /* Stalled */
  .lx{background:#1c1010;border:1px solid #ff7b7244;border-radius:8px;padding:14px;margin-bottom:18px}
  .lx h2{color:#ff7b72;font-size:14px;margin-bottom:8px}
  .li{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:11px;border-radius:3px}
  .li:hover{background:#221515}
  .ld{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .lid{color:#ff7b72;font-family:monospace;font-weight:600;min-width:120px;flex-shrink:0}
  .lcls{color:#ffa657;font-family:monospace;font-size:10px;min-width:80px;flex-shrink:0}
  .lloc{color:#8b949e;font-size:10px;flex:1}
  .li code{font-size:10px;background:#161b22;padding:1px 5px;border-radius:2px;color:#ffa657;white-space:nowrap;flex-shrink:0}
  /* Releases */
  .rl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px;margin-bottom:18px}
  .rl-card{border-radius:8px;padding:14px}
  .rl-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
  .rl-ver{font-size:18px;font-weight:700;color:#e6edf3;min-width:50px}
  .rl-title{font-size:13px;font-weight:600;color:#c9d1d9;flex:1}
  .rl-status{font-size:10px;font-weight:600;white-space:nowrap}
  .rl-desc{font-size:11px;color:#8b949e;margin-bottom:8px}
  .rl-bar-wrap{height:6px;background:#21262d;border-radius:3px;overflow:hidden;margin-bottom:2px}
  .rl-bar{display:block;height:100%;border-radius:3px;transition:width .3s}
  .rl-bar-label{font-size:10px;color:#8b949e;margin-bottom:8px}
  .rl-mods{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:10px}
  .rl-mod{color:#c9d1d9}
  .rl-mod-stat{color:#8b949e}
  .rl-warn{font-size:10px;color:#ff7b72;margin-top:4px}
  /* Version Plans */
  .pc{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:12px}
  .pch{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .pctt{font-size:14px;font-weight:600;color:#e6edf3}
  .pcm{font-size:11px;color:#8b949e}
  .vd{border:1px solid #21262d;border-radius:6px;margin-bottom:6px;overflow:hidden}
  .vs{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;background:#0d1117;user-select:none}
  .vs::-webkit-details-marker{display:none}
  .vs::before{content:'\\25B6';color:#484f58;font-size:9px;transition:transform .15s}
  details[open]>.vs::before{transform:rotate(90deg)}
  .vv{font-weight:600;font-size:12px;color:#e6edf3;min-width:30px}
  .vtg{display:inline-block;padding:1px 7px;border-radius:9px;font-size:9px;font-weight:600;color:#fff;min-width:45px;text-align:center}
  .vpb{flex:1;height:6px;background:#21262d;border-radius:3px;overflow:hidden;max-width:150px}
  .vpf{display:block;height:100%;border-radius:3px;transition:width .3s}
  .vpct{font-size:10px;color:#8b949e;white-space:nowrap;min-width:50px}
  .vb{padding:6px 10px 8px;border-top:1px solid #21262d}
  .vm{margin-bottom:4px}
  .vmt{font-size:11px;font-weight:600;color:#8b949e;padding:4px 0 2px;display:flex;align-items:center;gap:5px}
  .vmc{background:#21262d;color:#8b949e;font-size:9px;padding:0 5px;border-radius:7px}
  .vr{display:flex;align-items:center;gap:6px;padding:2px 6px;border-radius:3px;font-size:11px}
  .vr:hover{background:#1c2128}
  .vtic{font-size:11px;width:14px;text-align:center;flex-shrink:0}
  .vsic{font-size:11px;width:14px;text-align:center;flex-shrink:0}
  .vid{color:#58a6ff;font-family:monospace;font-size:10px;min-width:120px;flex-shrink:0}
  .vtl{color:#c9d1d9;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .st{display:inline-block;padding:0 5px;border-radius:2px;font-size:9px;font-weight:600;color:#fff;white-space:nowrap;flex-shrink:0}
  .vt{display:inline-block;padding:0 5px;border-radius:3px;font-size:9px;font-weight:600;background:#1f6feb33;color:#58a6ff;border:1px solid #1f6feb44;white-space:nowrap;flex-shrink:0}
  .ct{display:inline-block;padding:0 5px;border-radius:3px;font-size:9px;font-weight:600;background:#8957e533;color:#d2a8ff;border:1px solid #8957e544;white-space:nowrap;flex-shrink:0}
  .badge{display:inline-block;padding:0 5px;border-radius:8px;font-size:9px;font-weight:600;white-space:nowrap;flex-shrink:0}
  .badge-running{background:#1f6feb33;color:#58a6ff;border:1px solid #1f6feb66}
  .badge-frozen{background:#58a6ff22;color:#79c0ff;border:1px solid #58a6ff44}
  .badge-completed{background:#23863633;color:#3fb950;border:1px solid #23863666}
  .badge-draft{background:#8957e533;color:#d2a8ff;border:1px solid #8957e566}
  .badge-clarifying{background:#9e6a0333;color:#d29922;border:1px solid #9e6a0366}
  .badge-abandoned{background:#484f5833;color:#8b949e;border:1px solid #484f5866}
  .badge-unknown{background:#484f5833;color:#8b949e;border:1px solid #484f5866}
  /* Code Areas */
  .ad{border:1px solid #21262d;border-radius:6px;margin-bottom:6px;overflow:hidden}
  .as{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;background:#0d1117;user-select:none}
  .as::-webkit-details-marker{display:none}
  .as::before{content:'\\25B6';color:#484f58;font-size:9px;transition:transform .15s}
  details[open]>.as::before{transform:rotate(90deg)}
  .ai{font-size:14px}
  .al{font-weight:600;font-size:13px;color:#e6edf3;min-width:100px}
  .asc{font-size:11px;color:#8b949e;min-width:40px}
  .apb{flex:1;height:6px;background:#21262d;border-radius:3px;overflow:hidden;max-width:120px}
  .apf{display:block;height:100%;border-radius:3px;transition:width .3s}
  .apc{font-size:10px;color:#8b949e;white-space:nowrap;min-width:50px}
  .abd{padding:6px 12px 10px;border-top:1px solid #21262d}
  .am{margin-bottom:4px}
  .amt{font-size:11px;font-weight:600;color:#8b949e;padding:5px 0 3px;display:flex;align-items:center;gap:5px}
  .amc{background:#21262d;color:#8b949e;font-size:9px;padding:0 5px;border-radius:7px}
  .ar{display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:3px;font-size:11px}
  .ar:hover{background:#1c2128}
  .atic{font-size:11px;width:14px;text-align:center;flex-shrink:0}
  .asic{font-size:11px;width:14px;text-align:center;flex-shrink:0}
  .aid{color:#58a6ff;font-family:monospace;font-size:10px;min-width:120px;flex-shrink:0}
  .atl{color:#c9d1d9;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* Events */
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{text-align:left;padding:5px 8px;border-bottom:2px solid #30363d;color:#8b949e;font-weight:600;font-size:10px}
  td{padding:4px 8px;border-bottom:1px solid #21262d}
  tr:hover td{background:#161b22}
  .etm{font-size:10px;color:#8b949e;white-space:nowrap}
  .eet{font-family:monospace;font-size:10px;color:#d2a8ff}
  .ft{margin-top:20px;padding:12px 0;border-top:1px solid #21262d;color:#484f58;font-size:10px;display:flex;justify-content:space-between}
  /* Actions */
  .ax{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 14px;margin-bottom:18px}
  .ax-row{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:11px}
  .ax-icon{width:14px;text-align:center;flex-shrink:0}
  .ax-cmd{font-family:monospace;font-size:10px;color:#58a6ff;background:#0d1117;padding:1px 6px;border-radius:3px;min-width:200px;flex-shrink:0}
  .ax-why{color:#8b949e;font-size:10px;flex:1}
  .empty{color:#484f58;text-align:center;padding:20px;font-size:12px}
</style>
</head>
<body>
<h1>📊 zelto <small>工程总览 · ${new Date().toLocaleString()}</small></h1>
<p class="sub">${watchMode ? '🔄 Watch mode' : 'Run <code>zelto dashboard --watch</code> for live updates'}</p>

${summary}

<div class="lg">
  <span>💻 code</span><span>📄 docs</span><span>⚙️ config</span><span>♻️ refactor</span>
  <span class="sp">|</span>
  <span>📝 draft</span><span>❓ clarifying</span><span>❄️ frozen</span><span>🔄 running</span><span>✅ completed</span><span>🗑️ abandoned</span>
</div>

<div class="br">${stateBar || '<div style="color:#484f58;padding:8px;font-size:12px">No slices</div>'}</div>
<div class="br">${typeBar || ''}</div>

${stalledLayer}
${costLayer}
${releaseLayer}
${planLayer}
${areaLayer}

<!-- Action Items -->
${actions.length === 0 ? '' : `
<h2 class="sh">📋 Next Actions <span class="hc">${actions.length} items</span></h2>
<div class="ax">${actions.map((a) => {
  const icon = a.priority === 1 ? '🔴' : a.priority === 2 ? '🔵' : '⚪';
  return `<div class="ax-row"><span class="ax-icon">${icon}</span><code class="ax-cmd">${esc(a.command)}</code><span class="ax-why">${esc(a.reason)}</span></div>`;
}).join('')}</div>`}

<h2 class="sh">📜 Recent Events</h2>
<table>
<thead><tr><th>Time</th><th>Type</th><th>Slice</th><th>Actor</th></tr></thead>
<tbody>${eventRows || '<tr><td colspan="4" class="empty">No events</td></tr>'}</tbody>
</table>

<div class="ft">
  <span>Generated by zelto dashboard</span>
  <span id="ut">${new Date().toISOString()}</span>
</div>

${watchMode ? '<script>setInterval(function(){location.reload()},3000)</script>' : ''}
</body>
</html>`;
}

// ─── Command ─────────────────────────────────────────────────────────────────

register('dashboard', async (args) => {
  const watchMode = args.includes('--watch');
  const openBrowser = args.includes('--open');
  const ttyMode = args.includes('--tty');
  const jsonMode = args.includes('--json');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : join(process.cwd(), 'zelto-dashboard.html');

  const gather = async () => {
    const sliceMap = collectSlices();
    const plans = buildPlans(sliceMap);
    const releases = loadReleases();
    const slices = [...sliceMap.values()].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    const events = collectRecentEvents();
    const costMap = collectCosts();
    const budgetLimit = await readBudgetLimit();
    return { slices, plans, releases, events, costMap, budgetLimit };
  };

  // ── TTY mode ────────────────────────────────────────────────────────────
  if (ttyMode) {
    const { slices, plans, releases, events, costMap, budgetLimit } = await gather();
    process.stdout.write(renderTty(slices, plans, releases, events, costMap, budgetLimit));

    if (watchMode) {
      console.log(colors.dim('  👀 Watching... (Ctrl+C to stop)'));
      const regen = async () => {
        try {
          const d = await gather();
          process.stdout.write('\x1b[2J\x1b[H'); // clear screen
          process.stdout.write(
            renderTty(d.slices, d.plans, d.releases, d.events, d.costMap, d.budgetLimit),
          );
        } catch { /* ignore */ }
      };
      for (const sub of ['slices', 'versions', 'events']) {
        const d = join(ZELTO_DIR, sub);
        if (existsSync(d)) watch(d, { recursive: sub === 'events' }, regen);
      }
      await new Promise(() => {});
    }
    return 0;
  }

  // ── JSON mode ───────────────────────────────────────────────────────────
  if (jsonMode) {
    const { slices, plans, releases, events, costMap, budgetLimit } = await gather();
    console.log(renderJson(slices, plans, releases, events, costMap, budgetLimit));
    return 0;
  }

  // ── HTML mode (default) ─────────────────────────────────────────────────
  const generate = async () => {
    const { slices, plans, releases, events, costMap, budgetLimit } = await gather();
    return renderHtml(slices, plans, releases, events, watchMode, costMap, budgetLimit);
  };

  writeFileSync(outputPath, await generate(), 'utf-8');
  console.log(`📊 Dashboard generated: ${outputPath}`);

  if (openBrowser) {
    try {
      const { execSync } = await import('node:child_process');
      const p = process.platform;
      if (p === 'win32') execSync(`start "" "${outputPath}"`, { timeout: 5000 });
      else if (p === 'darwin') execSync(`open "${outputPath}"`, { timeout: 5000 });
      else execSync(`xdg-open "${outputPath}"`, { timeout: 5000 });
    } catch { console.log(`  Open manually: ${outputPath}`); }
  }

  if (watchMode) {
    console.log('  👀 Watching... (Ctrl+C to stop)');
    const regen = async () => {
      try {
        writeFileSync(outputPath, await generate(), 'utf-8');
      } catch { /* ignore */ }
    };
    for (const sub of ['slices', 'versions', 'events']) {
      const d = join(ZELTO_DIR, sub);
      if (existsSync(d)) watch(d, { recursive: sub === 'events' }, regen);
    }
    await new Promise(() => {});
  }

  return 0;
});
