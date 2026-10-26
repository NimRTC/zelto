// Report generator — produces Markdown or JSON project status reports
// from analyzed report data.

import type { ReportData, SliceStatusDistribution, VersionProgress, GateStats, EventStats, AnomalousSlice } from './report-analyzer.js';

export type ReportFormat = 'markdown' | 'json';

export function generateReport(data: ReportData, format: ReportFormat): string {
  switch (format) {
    case 'markdown':
      return generateMarkdown(data);
    case 'json':
      return generateJson(data);
  }
}

function generateMarkdown(data: ReportData): string {
  const lines: string[] = [];

  lines.push(`# 项目状态报告`);
  lines.push('');
  lines.push(`**生成时间**: ${new Date(data.project.generatedAt).toLocaleString()}`);
  lines.push(`**项目**: ${data.project.name}`);
  lines.push('');

  // ── 1. 需求与设计概览 ──
  lines.push('## 1. 需求与设计概览');
  lines.push('');
  lines.push('| 类型 | 总计 | 已确认 | 草稿 |');
  lines.push('|------|------|--------|------|');
  lines.push(`| 需求 | ${data.requirements.total} | ${data.requirements.confirmed} | ${data.requirements.draft} |`);
  lines.push(`| 设计 | ${data.designs.total} | ${data.designs.confirmed} | ${data.designs.draft} |`);
  lines.push(`| 计划 | ${data.plans.total} | ${data.plans.confirmed} | ${data.plans.draft} |`);
  lines.push('');

  // ── 2. 切片状态分布 ──
  lines.push('## 2. 切片状态分布');
  lines.push('');
  const s = data.slices;
  lines.push(`**总计**: ${s.total} 个切片`);
  lines.push('');
  lines.push('| 状态 | 数量 | 占比 |');
  lines.push('|------|------|------|');
  for (const [state, count] of Object.entries(getStateDistribution(s))) {
    const pct = s.total > 0 ? ((count / s.total) * 100).toFixed(1) : '0.0';
    lines.push(`| ${stateLabel(state)} | ${count} | ${pct}% |`);
  }
  lines.push('');

  // ── 3. 版本进度 ──
  lines.push('## 3. 版本进度');
  lines.push('');
  for (const v of data.versions) {
    const pct = v.totalSlices > 0 ? ((v.completedSlices / v.totalSlices) * 100).toFixed(0) : '0';
    lines.push(`### ${v.version} — ${v.description}`);
  lines.push('');
    lines.push(`- **状态**: ${v.status}`);
    lines.push(`- **切片进度**: ${v.completedSlices}/${v.totalSlices} (${pct}%)`);
    lines.push('');
    lines.push('| 切片 | 状态 |');
    lines.push('|------|------|');
    for (const [sliceId, state] of Object.entries(v.sliceStates)) {
      lines.push(`| ${sliceId} | ${stateLabel(state)} |`);
    }
    lines.push('');
  }

  // ── 4. 门禁通过率 ──
  lines.push('## 4. 门禁通过率');
  lines.push('');
  const g = data.gates;
  if (g.total > 0) {
    lines.push(`| 项目 | 数值 |`);
    lines.push(`|------|------|`);
    lines.push(`| 通过 | ${g.passed} |`);
    lines.push(`| 失败 | ${g.failed} |`);
    lines.push(`| 总计 | ${g.total} |`);
    lines.push(`| 通过率 | ${(g.passRate * 100).toFixed(1)}% |`);
  } else {
    lines.push('暂无门禁记录。');
  }
  lines.push('');

  // ── 5. 事件统计 ──
  lines.push('## 5. 事件统计');
  lines.push('');
  const e = data.events;
  lines.push(`**事件总量**: ${e.total}`);
  lines.push('');
  lines.push('| 事件类型 | 数量 |');
  lines.push('|----------|------|');
  const sortedTypes = Object.entries(e.byType).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    lines.push(`| \`${type}\` | ${count} |`);
  }
  lines.push('');

  if (e.recent.length > 0) {
    lines.push('### 最近事件');
    lines.push('');
    for (const ev of e.recent) {
      lines.push(`- \`${ev.type}\` — ${ev.slice} (${new Date(ev.ts).toLocaleString()})`);
    }
    lines.push('');
  }

  // ── 6. 异常切片 ──
  lines.push('## 6. 异常切片');
  lines.push('');
  if (data.anomalies.length === 0) {
    lines.push('✅ 无异常切片。');
  } else {
    lines.push('| 切片 | 状态 | 最后更新 | 最近事件 |');
    lines.push('|------|------|----------|----------|');
    for (const a of data.anomalies) {
      lines.push(`| ${a.id} | ${stateLabel(a.state)} | ${new Date(a.updatedAt).toLocaleString()} | ${a.lastEvent ?? '—'} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function generateJson(data: ReportData): string {
  return JSON.stringify(data, null, 2);
}

function getStateDistribution(s: SliceStatusDistribution): Record<string, number> {
  return {
    draft: s.draft,
    clarifying: s.clarifying,
    frozen: s.frozen,
    running: s.running,
    completed: s.completed,
    abandoned: s.abandoned,
  };
}

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    draft: '📝 草稿',
    clarifying: '❓ 澄清中',
    frozen: '❄️ 已冻结',
    running: '🔄 运行中',
    completed: '✅ 已完成',
    abandoned: '🗑️ 已废弃',
    planned: '⏳ 已规划',
    in_progress: '🔄 进行中',
    integrated: '✅ 已集成',
    delivered: '🚀 已交付',
  };
  return labels[state] ?? state;
}
