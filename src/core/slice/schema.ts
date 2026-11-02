// Slice schema utilities — default value filling, validation, backward compat
// v2: fills missing v2 fields with defaults when loading v1 slice data

import type { SliceData } from './store.js';
import type { SliceStage, SliceStatus } from './types.js';

// ─── Defaults ───────────────────────────────────────────────────────────────

export const V2_FIELD_DEFAULTS = {
  stage: 'draft' as SliceStage,
  status: 'spec' as SliceStatus,
  milestone: null as string | null,
  tags: [] as string[],
  supersededBy: null as string | null,
};

// ─── SliceData v2 field helpers ─────────────────────────────────────────────

/**
 * Extended SliceData with v2 fields.
 * This is the runtime shape after defaults are filled.
 */
export interface SliceDataV2 extends SliceData {
  stage: SliceStage;
  status: SliceStatus;
  milestone: string | null;
  tags: string[];
  supersededBy: string | null;
}

/**
 * Fill missing v2 fields on a SliceData object with defaults.
 * This ensures backward compatibility when loading v1 slice files.
 *
 * Mutates the input object and returns it for chaining.
 */
export function fillV2Defaults(data: SliceData): SliceDataV2 {
  const d = data as SliceDataV2;
  if (d.stage === undefined || d.stage === null) d.stage = V2_FIELD_DEFAULTS.stage;
  if (d.status === undefined || d.status === null) d.status = V2_FIELD_DEFAULTS.status;
  if (d.milestone === undefined || d.milestone === null) d.milestone = V2_FIELD_DEFAULTS.milestone;
  if (!Array.isArray(d.tags)) d.tags = [...V2_FIELD_DEFAULTS.tags];
  if (d.supersededBy === undefined || d.supersededBy === null) d.supersededBy = V2_FIELD_DEFAULTS.supersededBy;
  return d;
}

/**
 * Read a slice and ensure v2 fields are filled.
 * Wraps SliceStore.read with automatic default filling.
 */
export function readWithV2Defaults(data: SliceData): SliceDataV2 {
  return fillV2Defaults(data);
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface V2ValidationError {
  field: string;
  message: string;
}

/**
 * Validate v2 field values on a SliceDataV2 object.
 * Returns an array of validation errors (empty = valid).
 */
export function validateV2Fields(data: SliceDataV2): V2ValidationError[] {
  const errors: V2ValidationError[] = [];

  // stage validation
  const validStages = ['draft', 'active', 'frozen', 'retired'];
  if (!validStages.includes(data.stage)) {
    errors.push({ field: 'stage', message: `Invalid stage "${data.stage}". Must be one of: ${validStages.join(', ')}` });
  }

  // status validation
  const validStatuses = ['spec', 'accept', 'impl', 'done'];
  if (!validStatuses.includes(data.status)) {
    errors.push({ field: 'status', message: `Invalid status "${data.status}". Must be one of: ${validStatuses.join(', ')}` });
  }

  // tags validation
  if (!Array.isArray(data.tags)) {
    errors.push({ field: 'tags', message: 'Tags must be an array of strings' });
  } else {
    for (const tag of data.tags) {
      if (typeof tag !== 'string') {
        errors.push({ field: 'tags', message: 'Each tag must be a string' });
      } else if (tag.length > 32) {
        errors.push({ field: 'tags', message: `Tag "${tag}" exceeds 32 characters (length: ${tag.length})` });
      }
    }
  }

  // milestone validation
  if (data.milestone !== null && typeof data.milestone !== 'string') {
    errors.push({ field: 'milestone', message: 'Milestone must be a string or null' });
  }

  // superseded-by validation
  if (data.supersededBy !== null && typeof data.supersededBy !== 'string') {
    errors.push({ field: 'supersededBy', message: 'Superseded-by must be a string or null' });
  }

  return errors;
}
