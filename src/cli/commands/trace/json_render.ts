// JSON output formatting for the trace command

import type { TraceData } from './model.js';

/**
 * Render trace data as a formatted JSON string.
 */
export function renderJsonTrace(data: TraceData): string {
  return JSON.stringify(data, null, 2);
}
