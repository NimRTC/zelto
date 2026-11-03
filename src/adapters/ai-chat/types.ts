// AI Chat Adapter — type definitions
// L0: shared types for router, command-builder, and entry point

/**
 * Recognised intent categories.
 * Each maps to a group of zelto CLI commands.
 */
export type IntentCategory =
  | 'slice'
  | 'gate'
  | 'stall'
  | 'slice-plan'
  | 'event'
  | 'agent'
  | 'help'
  | 'unknown';

/**
 * A parsed intent from natural-language input.
 *
 * @property category  — the broad command group
 * @property action    — the specific verb within that group (e.g. "create", "list")
 * @property params    — extracted parameters (e.g. { sliceId: "v1-foo" })
 */
export interface Intent {
  category: IntentCategory;
  action: string;
  params: Record<string, string>;
}

/**
 * Result returned by the router.
 *
 * @property intent      — the parsed intent
 * @property confidence  — match confidence between 0 and 1
 */
export interface RouterResult {
  intent: Intent;
  confidence: number;
}

/**
 * A concrete zelto CLI command produced by the command builder.
 *
 * @property command  — the CLI command name (e.g. "slice", "gate")
 * @property args     — CLI arguments (e.g. ["create", "v1-foo"])
 * @property label    — human-readable label for output
 */
export interface CommandSpec {
  command: string;
  args: string[];
  label: string;
}
