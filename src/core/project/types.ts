// Project types — project scan results and governance state

export type ProjectType = 'node' | 'python' | 'rust' | 'go' | 'cpp' | 'unknown';

export interface ProjectModule {
  name: string;
  files: string[];
  testFiles: string[];
  entryPoint: string | null;
  submodules: ProjectModule[];
}

export interface ProjectMap {
  projectName: string;
  projectType: ProjectType;
  rootDir: string;
  detectedAt: string;
  modules: ProjectModule[];
  configFiles: string[];
  buildTool: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  ignorePatterns: string[];
}

export interface ProjectInitOptions {
  /** Auto-detect test/lint commands */
  autoDetect: boolean;
  /** Policy rules to include (default: src/** writes, policy/** protected) */
  policyTemplate: 'default' | 'minimal';
}

export interface ProjectStatus {
  hasZeltoDir: boolean;
  hasPolicy: boolean;
  hasConfig: boolean;
  hasProjectMap: boolean;
  designCount: number;
  sliceCount: number;
  planCount: number;
  adoptionStage: 'none' | 'scanned' | 'initialized' | 'designed' | 'sliced';
}
