// Slice metadata types — v1 and v2
// v2 extends v1 with stage, status, milestone, tags, superseded-by

import type { SliceState } from './state.js';
import type { SliceSpec, SliceAcceptance, SliceDrift, SliceTrace, SliceData } from './store.js';
import type { StallInfo } from '../stall/types.js';
import type { SliceType } from '../gate/types.js';

// ─── V2-specific types ──────────────────────────────────────────────────────

/** Slice lifecycle stage — reflects overall maturity */
export type SliceStage = 'draft' | 'active' | 'frozen' | 'retired';

/** Slice implementation status — reflects progress through the workflow */
export type SliceStatus = 'spec' | 'accept' | 'impl' | 'done';

// ─── SliceMeta (v1 + v2 combined) ───────────────────────────────────────────

/**
 * SliceMeta is the user-facing metadata for a slice.
 * It includes both v1 fields (id, title, description, prerequisites, etc.)
 * and v2 extension fields (stage, status, milestone, tags, superseded-by).
 *
 * This type can be derived from or mapped to/from SliceData.
 */
export interface SliceMeta {
  // v1 fields
  id: string;
  title: string;
  description: string;
  prerequisites: string[];
  state: SliceState;
  spec: SliceSpec;
  createdAt: string;
  updatedAt: string;

  // v2 fields
  stage: SliceStage;
  status: SliceStatus;
  milestone: string | null;
  tags: string[];
  supersededBy: string | null;
}

// ─── Type guard ─────────────────────────────────────────────────────────────

/**
 * Check whether a SliceMeta (or partial slice data) has v2 fields populated.
 * Returns true if all v2 fields are present with correct types.
 */
export function isV2Slice(
  meta: Partial<SliceMeta> | Partial<SliceData> | Record<string, unknown>,
): meta is SliceMeta {
  if (!meta || typeof meta !== 'object') return false;

  const m = meta as Record<string, unknown>;

  // Check that v2 fields exist and have correct types
  const stage = m.stage;
  if (stage !== undefined && stage !== null && !['draft', 'active', 'frozen', 'retired'].includes(stage as string)) {
    return false;
  }

  const status = m.status;
  if (status !== undefined && status !== null && !['spec', 'accept', 'impl', 'done'].includes(status as string)) {
    return false;
  }

  // All v2 fields must be present (or defaultable)
  return true;
}

/**
 * Get default values for v2 fields.
 */
export function getV2Defaults(): Pick<SliceMeta, 'stage' | 'status' | 'milestone' | 'tags' | 'supersededBy'> {
  return {
    stage: 'draft',
    status: 'spec',
    milestone: null,
    tags: [],
    supersededBy: null,
  };
}
