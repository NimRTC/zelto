// Report analyzer — reads project data from stores and computes aggregate statistics
// Used by the report generator to produce Markdown/JSON status reports.

import type { SliceData } from '../slice/store.js';
import type { VersionPlan, Version } from '../version/types.js';
import type { RequirementSummary } from '../requirements/types.js';
import type { DesignSummary } from '../design/types.js';
import type { EventEnvelope } from '../events/stream.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SliceStatusDistribution {
  draft: number;
  clarifying: number;
  frozen: number;
  running: number;
  completed: number;
  abandoned: number;
  total: number;
}

export interface VersionProgress {
  version: string;
  description: string;
  status: string;
  totalSlices: number;
  completedSlices: number;
  sliceStates: Record<string, string>;
}

export interface GateStats {
  passed: number;
  failed: number;
  total: number;
  passRate: number;
}

export interface EventStats {
  total: number;
  byType: Record<string, number>;
  recent: EventEnvelope[];
}

export interface AnomalousSlice {
  id: string;
  title: string;
  state: string;
  reason: string;
  updatedAt: string;
  lastEvent: string | null;
}

export interface ReportData {
  project: {
    name: string;
    generatedAt: string;
  };
  requirements: {
    total: number;
    confirmed: number;
    draft: number;
  };
  designs: {
    total: number;
    confirmed: number;
    draft: number;
  };
  plans: {
    total: number;
    confirmed: number;
    draft: number;
  };
  slices: SliceStatusDistribution;
  versions: VersionProgress[];
  gates: GateStats;
  events: EventStats;
  anomalies: AnomalousSlice[];
  policy: {
    totalRules: number;
    allowRules: number;
    denyRules: number;
    askRules: number;
    protectedPaths: string[];
  };
  snapshots: {
    total: number;
    latest: string | null;
    latestAt: string | null;
  };
}

export async function analyzeReport(
  slices: SliceData[],
  plans: VersionPlan[],
  reqSummaries: RequirementSummary[],
  designSummaries: DesignSummary[],
  allEvents: Map<string, EventEnvelope[]>,
): Promise<ReportData> {
  // Slice status distribution
  const dist: SliceStatusDistribution = {
    draft: 0, clarifying: 0, frozen: 0, running: 0, completed: 0, abandoned: 0, total: slices.length,
  };
  for (const s of slices) {
    const stateKey = s.state as keyof SliceStatusDistribution;
    if (stateKey in dist) dist[stateKey]++;
  }

  // Version progress
  const versions: VersionProgress[] = [];
  for (const plan of plans) {
    for (const v of plan.versions) {
      const completedSlices = v.slices.filter((sv) => {
        const sd = slices.find((s) => s.id === sv.id);
        return sd?.state === 'completed' || sd?.state === 'abandoned';
      }).length;
      const sliceStates: Record<string, string> = {};
      for (const sv of v.slices) {
        const sd = slices.find((s) => s.id === sv.id);
        sliceStates[sv.id] = sd?.state ?? '—';
      }
      versions.push({
        version: v.version,
        description: v.description,
        status: v.status,
        totalSlices: v.slices.length,
        completedSlices,
        sliceStates,
      });
    }
  }

  // Gate stats from events
  let gatePassed = 0;
  let gateFailed = 0;
  const allEventsFlat: EventEnvelope[] = [];
  for (const events of allEvents.values()) {
    allEventsFlat.push(...events);
    for (const e of events) {
      if (e.type === 'gate.result') {
        if (e.payload?.passed === true) gatePassed++;
        else gateFailed++;
      }
    }
  }
  const gates: GateStats = {
    passed: gatePassed,
    failed: gateFailed,
    total: gatePassed + gateFailed,
    passRate: gatePassed + gateFailed > 0 ? gatePassed / (gatePassed + gateFailed) : 0,
  };

  // Event stats
  const byType: Record<string, number> = {};
  for (const e of allEventsFlat) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
  }
  // Sort recent events by timestamp descending
  const sorted = [...allEventsFlat].sort((a, b) => b.ts.localeCompare(a.ts));
  const eventStats: EventStats = {
    total: allEventsFlat.length,
    byType,
    recent: sorted.slice(0, 10),
  };

  // Anomalous slices — slices in frozen state for >24h, or with drift detected
  const now = Date.now();
  const anomalies: AnomalousSlice[] = [];
  for (const s of slices) {
    let reason: string | null = null;
    if (s.drift.detected) {
      reason = s.drift.reason ?? 'drift detected';
    } else if (s.stall.class) {
      reason = `stalled: ${s.stall.class}`;
    } else if (s.state === 'frozen') {
      const age = now - new Date(s.updatedAt).getTime();
      if (age > 24 * 60 * 60 * 1000) {
        reason = `frozen for ${Math.round(age / (60 * 60 * 1000))}h`;
      }
    }
    if (reason) {
      const sliceEvents = allEvents.get(s.id) ?? [];
      const lastEvent = sliceEvents.length > 0
        ? sliceEvents[sliceEvents.length - 1].type
        : null;
      anomalies.push({
        id: s.id,
        title: s.title,
        state: s.state,
        reason,
        updatedAt: s.updatedAt,
        lastEvent,
      });
    }
  }

  // Policy stats — read policy.yaml and count rules by action
  let totalRules = 0;
  let allowRules = 0;
  let denyRules = 0;
  let askRules = 0;
  const protectedPaths: string[] = [];
  try {
    const policyPath = join(process.cwd(), 'policy', 'policy.yaml');
    if (existsSync(policyPath)) {
      const content = readFileSync(policyPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('action:')) {
          const action = trimmed.slice(7).trim();
          if (action === 'allow') allowRules++;
          else if (action === 'deny') denyRules++;
          else if (action === 'ask') askRules++;
          totalRules++;
        }
      }
      // Also read PROTECTED_PATTERNS from engine.ts comment or just hardcode
      protectedPaths.push(
        'policy/**', '.zelto/**', 'AGENTS.md',
        '.cursor/rules/**', 'zelto-hook', 'zelto-hook.exe',
      );
    }
  } catch {
    // Policy file doesn't exist or unreadable
  }

  // Snapshot stats
  let snapshotTotal = 0;
  let snapshotLatest: string | null = null;
  let snapshotLatestAt: string | null = null;
  try {
    const snapDir = join(process.cwd(), '.zelto', 'events', 'snapshots');
    if (existsSync(snapDir)) {
      const files = readdirSync(snapDir).filter((f) => f.endsWith('.json')).sort().reverse();
      snapshotTotal = files.length;
      if (files.length > 0) {
        snapshotLatest = files[0].replace(/\.json$/, '');
        try {
          const latestContent = readFileSync(join(snapDir, files[0]), 'utf-8');
          const latestData = JSON.parse(latestContent);
          snapshotLatestAt = latestData.capturedAt ?? null;
        } catch {
          // ignore parse errors
        }
      }
    }
  } catch {
    // Snapshots directory doesn't exist
  }

  return {
    project: {
      name: 'zelto',
      generatedAt: new Date().toISOString(),
    },
    requirements: {
      total: reqSummaries.length,
      confirmed: reqSummaries.filter((r) => r.status === 'confirmed').length,
      draft: reqSummaries.filter((r) => r.status === 'draft').length,
    },
    designs: {
      total: designSummaries.length,
      confirmed: designSummaries.filter((d) => d.status === 'confirmed').length,
      draft: designSummaries.filter((d) => d.status === 'draft').length,
    },
    plans: {
      total: plans.length,
      confirmed: plans.filter((p) => p.status === 'confirmed').length,
      draft: plans.filter((p) => p.status === 'draft').length,
    },
    slices: dist,
    versions,
    gates,
    events: eventStats,
    anomalies,
    policy: {
      totalRules,
      allowRules,
      denyRules,
      askRules,
      protectedPaths,
    },
    snapshots: {
      total: snapshotTotal,
      latest: snapshotLatest,
      latestAt: snapshotLatestAt,
    },
  };
}
