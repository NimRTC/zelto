// Spec merge — apply overlays to a base spec to produce an effective spec
//
// C3: deterministic, no model calls, no network
// C6: core/ only — no adapters/ imports

import type { SpecOverlay, SpecOverlayType, EffectiveSpec, SpecDocument } from './types.js';

/**
 * Set a value at a JSON path inside an object (mutates in place).
 * Supports dotted paths like "a.b.c" and array indices like "items.0.name".
 */
function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];
  current[lastKey] = value;
}

/**
 * Delete a value at a JSON path inside an object (mutates in place).
 */
function deleteAtPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      return; // path doesn't exist, nothing to delete
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];
  delete current[lastKey];
}

/**
 * Deep-merge a source value into a target value.
 * For objects, merges recursively. For arrays or primitives, source wins.
 */
function deepMerge(target: unknown, source: unknown): unknown {
  if (
    typeof target === 'object' &&
    target !== null &&
    !Array.isArray(target) &&
    typeof source === 'object' &&
    source !== null &&
    !Array.isArray(source)
  ) {
    const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const key of Object.keys(source as Record<string, unknown>)) {
      result[key] = deepMerge(result[key], (source as Record<string, unknown>)[key]);
    }
    return result;
  }

  // Arrays and primitives: source wins
  return source;
}

/**
 * Apply overlays to a path's current value.
 */
function applyOverlayValue(
  currentValue: unknown,
  overlay: SpecOverlay,
): unknown {
  switch (overlay.type as unknown as string) {
    case 'replace':
      return overlay.value;
    case 'merge':
      return deepMerge(currentValue, overlay.value);
    case 'delete':
      return undefined; // signals deletion
    default:
      return overlay.value;
  }
}

/**
 * Sort overlays by timestamp (ascending).
 * Stable sort — overlays with equal timestamps keep their original order.
 */
function sortOverlaysByTimestamp(overlays: SpecOverlay[]): SpecOverlay[] {
  return [...overlays].sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return -1;
    if (Number.isNaN(tb)) return 1;
    return ta - tb;
  });
}

/**
 * Merge a base spec with overlay specs to produce an effective spec.
 *
 * Algorithm:
 * 1. Start with a deep copy of the base spec
 * 2. Sort overlays by timestamp (ascending)
 * 3. For each overlay:
 *    - `replace`: set overlay.value at overlay.path
 *    - `merge`: deep-merge overlay.value into the value at overlay.path
 *    - `delete`: remove the value at overlay.path
 * 4. Return EffectiveSpec with the merged content and list of applied overlays
 *
 * @param spec - The base spec document
 * @param overlays - Ordered list of overlays to apply
 * @returns The effective spec with metadata
 */
export function getEffectiveSpec(
  spec: SpecDocument,
  overlays: SpecOverlay[],
): EffectiveSpec {
  // Deep clone the base spec to avoid mutation
  const content: Record<string, unknown> = JSON.parse(JSON.stringify(spec));

  // Sort overlays by timestamp
  const sorted = sortOverlaysByTimestamp(overlays);

  // Track which overlays were actually applied
  const appliedOverlays: SpecOverlay[] = [];

  for (const overlay of sorted) {
    const ot = overlay.type as unknown as string;

    if (ot === 'delete') {
      deleteAtPath(content, overlay.path);
    } else if (ot === 'replace' || ot === 'merge') {
      const currentValue = resolvePath(content, overlay.path);
      const newValue = applyOverlayValue(currentValue, overlay);
      if (newValue !== undefined) {
        setAtPath(content, overlay.path, newValue);
      }
    }

    appliedOverlays.push(overlay);
  }

  return {
    specId: (spec as Record<string, unknown>).id as string ?? '',
    specPath: (spec as Record<string, unknown>).path as string ?? '',
    content,
    appliedOverlays,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Resolve a dotted path against an object and return the value at that path.
 * Returns undefined if any segment along the path doesn't exist.
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const key of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}
