// Annotation module — pure document analysis for SliceSpec source tracking
//
// C7: llm/ output is only annotations/drafts, never decisions.
// The Annotation record is metadata for audit trail, not a gate decision.
//
// Constraints honored:
// - No imports from adapters/ or core/
// - No network calls or LLM invocations
// - Does not modify the SliceSpec type itself

/**
 * Minimal slice info needed for annotation.
 * Does NOT import the core SliceSpec type (C6: core/ not importable from llm/).
 */
export interface AnnotatableSpec {
  /** Slice identifier */
  id: string;
  /** Human-readable title */
  title: string;
  /** File paths this slice is allowed to write */
  writes: string[];
}

/**
 * Context in which a SliceSpec was produced.
 */
export interface AnnotationContext {
  /** Index or reference of the source user instruction */
  sourceInstruction: string;
  /** File paths used as context when generating this spec */
  contextFiles: string[];
  /** Hard-constraint numbers referenced (e.g. ["C1","C3","C5"]) */
  invariantRefs: string[];
}

/**
 * Annotation record for a SliceSpec.
 * Standalone metadata — does not alter the original spec.
 */
export interface Annotation {
  /** Slice ID this annotation belongs to */
  sliceId: string;
  /** Source user instruction index/ref */
  sourceInstruction: string;
  /** Context files used */
  contextFiles: string[];
  /** Invariant references */
  invariantRefs: string[];
  /** ISO 8601 timestamp of annotation creation */
  createdAt: string;
}

/**
 * Annotate a SliceSpec with source instruction, context files, and invariant references.
 *
 * Pure document analysis:
 * - No LLM calls (C7: llm/ output is only suggestions/annotations, never decisions)
 * - No network access
 * - No imports from adapters/ or core/
 *
 * Returns a standalone Annotation record without modifying the original spec.
 */
export async function annotateSpec(
  spec: AnnotatableSpec,
  context: AnnotationContext,
): Promise<Annotation> {
  return {
    sliceId: spec.id,
    sourceInstruction: context.sourceInstruction,
    contextFiles: [...context.contextFiles],
    invariantRefs: [...context.invariantRefs],
    createdAt: new Date().toISOString(),
  };
}
