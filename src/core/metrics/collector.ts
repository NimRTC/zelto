// Metrics collector — derives metrics from event streams
// C3: deterministic — no model calls, no network
// See contracts/schemas/metrics-def.json

import type { EventStream, EventEnvelope } from '../events/stream.js';

export interface MetricDefinition {
  name: string;
  version: string;
  description: string;
  reads: string[];
  parameters: Record<string, unknown>;
}

export interface MetricSnapshot {
  name: string;
  sliceId: string;
  value: number;
  unit: string;
  timestamp: string;
  dimensions?: Record<string, string>;
}

export interface MetricsReport {
  generatedAt: string;
  metrics: MetricSnapshot[];
  sliceCount: number;
  eventCount: number;
}

export class MetricsCollector {
  private readonly events: EventStream;

  constructor(events: EventStream) {
    this.events = events;
  }

  /**
   * Count events of a given type for a slice.
   */
  async countEvents(sliceId: string, eventTypes: string[]): Promise<number> {
    const evts = await this.events.read(sliceId);
    return evts.filter((e) => eventTypes.includes(e.type)).length;
  }

  /**
   * Calculate rework rate: gate.retry / gate.executed for a slice.
   */
  async reworkRate(sliceId: string): Promise<MetricSnapshot | null> {
    const evts = await this.events.read(sliceId);
    const executed = evts.filter((e) => e.type === 'gate.executed').length;
    const retries = evts.filter((e) => e.type === 'gate.retry').length;

    if (executed === 0) return null;

    return {
      name: 'rework_rate',
      sliceId,
      value: executed > 0 ? retries / executed : 0,
      unit: 'ratio',
      timestamp: new Date().toISOString(),
      dimensions: { executed: String(executed), retries: String(retries) },
    };
  }

  /**
   * Calculate cycle time: time from first event to gate.result for a slice.
   */
  async cycleTime(sliceId: string): Promise<MetricSnapshot | null> {
    const evts = await this.events.read(sliceId);
    if (evts.length < 2) return null;

    const first = evts[0];
    const last = evts[evts.length - 1];

    const startMs = new Date(first.ts).getTime();
    const endMs = new Date(last.ts).getTime();

    return {
      name: 'cycle_time',
      sliceId,
      value: Math.max(0, endMs - startMs) / 1000,
      unit: 'seconds',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Count stalls by class for a slice.
   */
  async stallCounts(sliceId: string): Promise<MetricSnapshot> {
    const evts = await this.events.read(sliceId);
    const stallEvents = evts.filter((e) => e.type === 'stall.classified');

    const stallClasses = new Map<string, number>();
    for (const e of stallEvents) {
      const cls = String(e.payload?.class ?? 'unknown');
      stallClasses.set(cls, (stallClasses.get(cls) || 0) + 1);
    }

    return {
      name: 'stall_counts',
      sliceId,
      value: stallEvents.length,
      unit: 'count',
      timestamp: new Date().toISOString(),
      dimensions: Object.fromEntries(
        [...stallClasses.entries()].map(([k, v]) => [k, String(v)]),
      ),
    };
  }

  /**
   * Generate a full metrics report across all slices.
   */
  async generateReport(sliceIds: string[]): Promise<MetricsReport> {
    const snapshots: MetricSnapshot[] = [];
    let totalEvents = 0;

    for (const id of sliceIds) {
      try {
        const evts = await this.events.read(id);
        totalEvents += evts.length;

        const rework = await this.reworkRate(id);
        if (rework) snapshots.push(rework);

        const cycle = await this.cycleTime(id);
        if (cycle) snapshots.push(cycle);

        const stalls = await this.stallCounts(id);
        snapshots.push(stalls);
      } catch {
        // Skip unreadable slices
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      metrics: snapshots,
      sliceCount: sliceIds.length,
      eventCount: totalEvents,
    };
  }
}
