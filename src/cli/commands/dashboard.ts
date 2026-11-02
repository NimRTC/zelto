// Dashboard — project bird's-eye view
// Layers: ① Abnormalities ② Releases ③ Version Plans ④ Code Areas (collapsed)
// Usage: zelto dashboard [--watch] [--open] [--output <path>]

import { existsSync, readFileSync, readdirSync, writeFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { register, ZELTO_DIR } from './shared.js';
import { loadReleases, type ReleaseDef } from './releases.js';
import { detectSliceType, type SliceType } from '../../core/gate/types.js';

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

// ─── Cost Collection ────────────────────────────────────────────────────────────

interface SliceCost {
  totalCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
}

function collectCosts(): Map<string, SliceCost> {
  const dir = join(ZELTO_DIR, 'events');
  const costMap = new Map<string, SliceCost>();
  if (!existsSync(dir)) return costMap;

  for (const sd of readdirSync(dir, { withFileTypes: true })) {
    if (!sd.isDirectory()) continue;
    const sliceId = sd.name;
    const f = join(dir, sliceId, 'events.jsonl');
    if (!existsSync(f)) continue;

    let totalCost = 0;
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let llmCalls = 0;

    try {
      for (const line of readFileSync(f, 'utf-8').split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          if (e.type === 'llm.called') {
            llmCalls++;
            totalTokens += e.payload?.totalTokens ?? 0;
            promptTokens += e.payload?.promptTokens ?? 0;
            completionTokens += e.payload?.completionTokens ?? 0;
            totalCost += e.payload?.cost ?? 0;
          } else if (e.type === 'budget.spent') {
            totalCost += e.payload?.amount ?? 0;
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }

    if (llmCalls > 0 || totalCost > 0) {
      costMap.set(sliceId, { totalCost, totalTokens, promptTokens, completionTokens, llmCalls });
    }
  }
  return costMap;
}

function fmtCost(cost: number): string {
  if (cost === 0) return '$0';
  if (cost < 0.01) return '$' + cost.toFixed(4);
  if (cost < 1) return '$' + cost.toFixed(3);
  return '$' + cost.toFixed(2);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
): string {
  const stalled = slices.filter((s) => s.stallClass);
  const stateCnt: Record<string, number> = {};
  const typeCnt: Record<string, number> = {};
  for (const s of slices) { stateCnt[s.state] = (stateCnt[s.state] ?? 0) + 1; typeCnt[s.type] = (typeCnt[s.type] ?? 0) + 1; }

  // Build lookup: planId → plan
  const planMap = new Map(plans.map((p) => [p.planId, p]));

  // Cost calculations
  let totalCostAll = 0;
  let totalTokensAll = 0;
  let totalLlmCalls = 0;
  for (const c of costMap.values()) {
    totalCostAll += c.totalCost;
    totalTokensAll += c.totalTokens;
    totalLlmCalls += c.llmCalls;
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const summary = `
<div class="g">
  <div class="c"><div class="n">${slices.length}</div><div class="l">Slices</div></div>
  <div class="c"><div class="n">${releases.length}</div><div class="l">Releases</div></div>
  <div class="c"><div class="n">${slices.filter((s) => s.state === 'running').length}</div><div class="l">🔄 Running</div></div>
  <div class="c st"><div class="n">${stalled.length}</div><div class="l">⚠️ Stalled</div></div>
  <div class="c" style="border-color:#58a6ff66"><div class="n">${fmtCost(totalCostAll)}</div><div class="l">💰 Total ${totalLlmCalls > 0 ? `(${totalLlmCalls} calls)` : ''}</div></div>
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
    return `<div class="li"><span class="ld" style="background:${stallColor(s.stallClass)}"></span><span class="lid">${s.id}</span><span class="lcls">${s.stallClass}</span><span class="lloc">${loc}</span><code>zelto resume ${s.id}</code></div>`;
  }).join('')}
</div>` : '';

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
      return `<span class="rl-mod">${icon} ${mod} <span class="rl-mod-stat">${d}/${t}${costStr}</span></span>`;
    }).join('');

  const bg = r.status === 'completed' ? '#1a2e1a' : r.status === 'in_progress' ? '#1a1f2e' : '#161b22';
  const border = r.status === 'in_progress' ? '1px solid #58a6ff66' : '1px solid #30363d';

  return `<div class="rl-card" style="background:${bg};border:${border}">
    <div class="rl-head">
      <span class="rl-ver">${r.version}</span>
      <span class="rl-title">${r.title}</span>
      <span class="rl-status" style="color:${statusColor(r.status)}">${statusLabel(r.status)}</span>
    </div>
    <div class="rl-desc">${r.description}</div>
    <div class="rl-bar-wrap"><span class="rl-bar" style="width:${pct}%;background:${pct===100?'#3fb950':sCnt>0?'#ff7b72':'#58a6ff'}"></span></div>
    <div class="rl-bar-label">${done}/${total} slices${sCnt ? ` · ⚠ ${sCnt} stalled` : ''}${total > 0 ? ` · ${pct}%` : ''}${relCost > 0 ? ` · ${fmtCost(relCost)}` : ''}</div>
    <div class="rl-mods">${moduleLines || '<span class="rl-mod-stat">(no slices assigned)</span>'}</div>
    ${unresolvedPlans.length > 0 ? `<div class="rl-warn">⚠ ${unresolvedPlans.join(', ')} not found</div>` : ''}
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
          const stallTag = s.stallClass ? `<span class="st" style="background:${stallColor(s.stallClass)}">⚠ ${s.stallClass}</span>` : '';
          const sc = costMap.get(s.id);
          const costTag = sc && sc.totalCost > 0 ? `<span class="ct">${fmtCost(sc.totalCost)}</span>` : '';
          return `<div class="vr"><span class="vtic">${tIcon(s.type)}</span><span class="vsic">${sIcon(s.state)}</span><span class="vid">${s.id}</span><span class="vtl">${s.title}</span><span class="badge badge-${s.state}">${s.state}</span>${costTag}${stallTag}</div>`;
        }).join('');
      if (!modName) return rows;
      return `<div class="vm"><div class="vmt">${modName} <span class="vmc">${modSlices.length}</span></div>${rows}</div>`;
    }).join('');

    return `<details class="vd" ${v.status === 'active' ? 'open' : ''}>
      <summary class="vs"><span class="vv">${v.name}</span><span class="vtg" style="background:${statusColor(v.status)}">${v.status}</span><span class="vpb"><span class="vpf" style="width:${pct}%;background:${pct===100?'#3fb950':sCnt>0?'#ff7b72':'#58a6ff'}"></span></span><span class="vpct">${done}/${total}${sCnt ? ` ⚠${sCnt}` : ''}</span></summary>
      <div class="vb">${moduleHtml}</div>
    </details>`;
  }).join('');

  return `<div class="pc"><div class="pch"><span class="pctt">${plan.title}</span><span class="pcm">${plan.versions.length} versions · ${plan.versions.reduce((a, v) => a + v.slices.length, 0)} slices</span></div>${versionsHtml}</div>`;
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
      const stallTag = s.stallClass ? `<span class="st" style="background:${stallColor(s.stallClass)}">⚠ ${s.stallClass}</span>` : '';
      const verTag = s.version ? `<span class="vt">${s.version}</span>` : '';
      const sc = costMap.get(s.id);
      const costTag = sc && sc.totalCost > 0 ? `<span class="ct">${fmtCost(sc.totalCost)}</span>` : '';
      return `<div class="ar"><span class="atic">${tIcon(s.type)}</span><span class="asic">${sIcon(s.state)}</span><span class="aid">${s.id}</span><span class="atl">${s.title}</span><span class="badge badge-${s.state}">${s.state}</span>${verTag}${costTag}${stallTag}</div>`;
    }).join('');
    if (!modName) return rows;
    return `<div class="am"><div class="amt">${modName} <span class="amc">${modSlices.length}</span></div>${rows}</div>`;
  }).join('');

  return `<details class="ad"><summary class="as"><span class="ai">${ad.icon}</span><span class="al">${ad.label}</span><span class="asc">${allSlices.length}</span><span class="apb"><span class="apf" style="width:${pct}%;background:${pct===100?'#3fb950':sCnt>0?'#ff7b72':'#58a6ff'}"></span></span><span class="apc">${done}/${allSlices.length}${sCnt ? ` ⚠${sCnt}` : ''}</span></summary><div class="abd">${modBlocks}</div></details>`;
}).join('')}` : '';

  // ══════════════════════════════════════════════════════════════════════════════
  // LAYER 5 — Events
  // ══════════════════════════════════════════════════════════════════════════════
  const eventRows = events.map((e) =>
    `<tr><td class="etm">${new Date(e.ts).toLocaleString()}</td><td><span class="eet">${e.type}</span></td><td>${e.slice}</td><td>${e.actor}</td></tr>`
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
${releaseLayer}
${planLayer}
${areaLayer}

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
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : join(process.cwd(), 'zelto-dashboard.html');

  const generate = () => {
    const sliceMap = collectSlices();
    const plans = buildPlans(sliceMap);
    const releases = loadReleases();
    const slices = [...sliceMap.values()].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    const events = collectRecentEvents();
    const costMap = collectCosts();
    return renderHtml(slices, plans, releases, events, watchMode, costMap);
  };

  writeFileSync(outputPath, generate(), 'utf-8');
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
    const regen = () => { try { writeFileSync(outputPath, generate(), 'utf-8'); } catch { /* ignore */ } };
    for (const sub of ['slices', 'versions', 'events']) {
      const d = join(ZELTO_DIR, sub);
      if (existsSync(d)) watch(d, { recursive: sub === 'events' }, regen);
    }
    await new Promise(() => {});
  }

  return 0;
});
