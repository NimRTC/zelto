// Data model types for trace command (v1 — JSON output path)

/** A requirement with its metadata */
export interface TraceRequirement {
  id: string;
  title: string;
  status: string;
  acceptanceCriteria: string[];
}

/** A module within a design */
export interface TraceModule {
  name: string;
  description: string;
  /** Other modules this module depends on (from DesignModule.dependencies) */
  dependencies: string[];
}

/** A design that traces from a requirement */
export interface TraceDesign {
  id: string;
  title: string;
  status: string;
  modules: TraceModule[];
  plans: TracePlan[];
}

/** A version plan linked to a design */
export interface TracePlan {
  id: string;
  title: string;
  status: string;
  versions: TraceVersion[];
}

/** A version within a plan, containing slices */
export interface TraceVersion {
  version: string;
  status: string;
  description: string;
  slices: TraceSlice[];
}

/** A slice within a version */
export interface TraceSlice {
  id: string;
  title: string;
  module: string;
  state: string;
}

/** Complete trace data: requirement → designs → plans → versions → slices */
export interface TraceData {
  requirement: TraceRequirement;
  designs: TraceDesign[];
}
