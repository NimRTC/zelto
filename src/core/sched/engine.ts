// Scheduler engine — parallel admission control
// C3: deterministic only — no model calls, no network
// C1: state in files only — reads from SliceStore

import type { SliceData, SliceStore } from '../slice/store.js';
import type { EventStream, EventType } from '../events/stream.js';
import type { PolicyConfig, PolicyRule } from '../policy/types.js';
import type { SchedResult, SchedBlock, SchedDecision, ConstraintBundle } from './types.js';
import { QUESTION_INSTRUCTIONS } from '../question/index.js';
import { pathMatches, writeSetsOverlap } from './paths.js';

export class Scheduler {
  private readonly store: SliceStore;
  private readonly events: EventStream;
  private readonly policy: PolicyConfig;

  constructor(store: SliceStore, events: EventStream, policy: PolicyConfig) {
    this.store = store;
    this.events = events;
    this.policy = policy;
  }

  /**
   * Check if a slice can be admitted for parallel execution.
   * A slice is blocked if its write-set overlaps with another running slice's write-set.
   */
  async admit(sliceId: string, actor: string = 'zelto'): Promise<SchedResult> {
    const slice = await this.store.read(sliceId);

    // Must be frozen or completed to run
    if (slice.state !== 'frozen' && slice.state !== 'completed') {
      return {
        sliceId,
        decision: 'blocked',
        reason: `Slice is in state "${slice.state}", must be "frozen" or "completed"`,
        blockedBy: [],
      };
    }

    // Must have a frozen spec
    if (!slice.spec.frozenHash) {
      return {
        sliceId,
        decision: 'blocked',
        reason: 'Slice has not been frozen (no frozenHash)',
        blockedBy: [],
      };
    }

    // Check write-set conflicts with running slices (skip for baseline slices)
    const allSlices = await this.store.list();
    const runningWrites = new Map<string, string[]>(); // sliceId → writes
    const blockedBy: string[] = [];

    if (slice.baseline) {
      // Baseline slices don't write new code — they only capture existing state
      // Skip writes reservation check to avoid blocking on unrelated running slices
      await this.appendEvent(sliceId, 'sched.admitted', actor, {
        sliceId, baseline: true, note: 'Baseline slice — writes reservation check skipped',
      });
      return {
        sliceId,
        decision: 'admitted',
        reason: null,
        blockedBy: [],
      };
    }

    for (const id of allSlices) {
      if (id === sliceId) continue;
      try {
        const s = await this.store.read(id);
        if (s.state === 'running') {
          runningWrites.set(id, s.writes);
        }
      } catch {
        // Skip unreadable slices
      }
    }

    // Check for write-set overlap
    for (const [runningId, writes] of runningWrites) {
      if (this.hasOverlap(slice.writes, writes)) {
        blockedBy.push(runningId);
      }
    }

    if (blockedBy.length > 0) {
      const block: SchedBlock = {
        sliceId,
        blockedBy,
        blockedAt: new Date().toISOString(),
        reason: `Write-set conflicts with: ${blockedBy.join(', ')}`,
      };

      await this.appendEvent(sliceId, 'sched.blocked', actor, block as unknown as Record<string, unknown>);

      return {
        sliceId,
        decision: 'blocked',
        reason: block.reason,
        blockedBy,
      };
    }

    await this.appendEvent(sliceId, 'sched.admitted', actor, { sliceId });

    return {
      sliceId,
      decision: 'admitted',
      reason: null,
      blockedBy: [],
    };
  }

  /**
   * Build a constraint bundle for an agent session.
   * Contains: spec path, frozen hash, acceptance dir, write-set, protected paths, policy rules.
   */
  buildConstraints(slice: SliceData): ConstraintBundle {
    // Collect relevant policy rules (exclude deny-all defaults, include specific rules)
    const relevantRules = this.policy.rules.filter((r) => {
      // Include rules that match the slice's write paths or are general allow/deny
      if (!r.match.path) return true;
      return slice.writes.some((w) => pathMatches(w, r.match.path!));
    });

    return {
      sliceId: slice.id,
      specPath: slice.spec.path,
      frozenHash: slice.spec.frozenHash,
      acceptanceDir: slice.acceptance.dir,
      writes: slice.writes,
      protectedPaths: [
        'policy/**',
        '.zelto/**',
        'AGENTS.md',
        '.cursor/rules/**',
      ],
      policyRules: relevantRules,
      instructions: this.buildInstructions(slice),
    };
  }

  /**
   * Mark a slice as running and record the admission.
   */
  async startRun(sliceId: string, actor: string = 'zelto'): Promise<SliceData> {
    return this.store.transit(sliceId, 'RUN_START', actor);
  }

  /**
   * Resume a stalled slice.
   *
   * @param sliceId - The slice to resume
   * @param options - Resume options
   * @param options.skip - If true, mark the stall as resolved without re-execution
   * @param options.abandon - If true, abandon the slice instead of resuming
   */
  async resume(
    sliceId: string,
    options: { skip?: boolean; abandon?: boolean },
  ): Promise<void> {
    const slice = await this.store.read(sliceId);

    if (slice.stall.class === null) {
      throw new Error(`Slice "${sliceId}" is not stalled`);
    }

    if (options.abandon) {
      await this.appendEvent(sliceId, 'run.resumed', 'zelto', {
        resolution: 'manual_abandon',
        previousStallClass: slice.stall.class,
      });
      await this.store.transit(sliceId, 'ABANDON');
      return;
    }

    const resolution = options.skip ? 'manual_skip' : 'manual_retry';

    await this.appendEvent(sliceId, 'run.resumed', 'zelto', {
      resolution,
      previousStallClass: slice.stall.class,
    });

    // Clear stall info for retry or skip
    slice.stall.class = null;
    await this.store.write(slice);
  }

  /**
   * Check write-set conflicts between multiple slices.
   * Returns pairs of indices (into writesList) that conflict.
   * Useful for parallel admission: verify no two slices write the same files.
   */
  checkConflicts(writesList: string[][]): Array<[number, number]> {
    const conflicts: Array<[number, number]> = [];
    for (let i = 0; i < writesList.length; i++) {
      for (let j = i + 1; j < writesList.length; j++) {
        if (this.hasOverlap(writesList[i], writesList[j])) {
          conflicts.push([i, j]);
        }
      }
    }
    return conflicts;
  }

  private hasOverlap(a: string[], b: string[]): boolean {
    return writeSetsOverlap(a, b);
  }

  private buildInstructions(slice: SliceData): string {
    return [
      `You are implementing slice "${slice.id}": ${slice.title}`,
      '',
      `## Spec`,
      `Read the spec at \`${slice.spec.path}\` (frozen at ${slice.spec.frozenHash ?? 'N/A'}).`,
      '',
      `## Write-set`,
      `You may only modify these paths:`,
      ...slice.writes.map((w) => `  - \`${w}\``),
      '',
      `## Protected paths (DO NOT MODIFY)`,
      `  - policy/`,
      `  - .zelto/`,
      `  - AGENTS.md`,
      `  - .cursor/rules/`,
      '',
      `## Acceptance tests`,
      `Run \`${slice.acceptance.dir}\` tests to verify your implementation.`,
      '',
      `## Rules`,
      `1. Do not modify files outside your write-set.`,
      `2. Do not modify protected paths.`,
      `3. All code must trace back to the spec.`,
      `4. Run acceptance tests before declaring completion.`,
      '',
      QUESTION_INSTRUCTIONS,
    ].join('\n');
  }

  private async appendEvent(
    sliceId: string,
    type: EventType,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.append(sliceId, type, actor, payload);
    } catch {
      // Event stream failure is non-fatal
    }
  }
}
