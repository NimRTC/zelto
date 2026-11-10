// Project types — project scan results and governance state

import type { EventType } from '../events/stream.js';

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

/**
 * 初始化时可选的依赖注入。
 *
 * 只有事件流一处：迁移是一个动作，动了文件就要留痕（C4）。
 * 不注入也能调 —— 只是不留痕（单元测试用）。
 */
export interface ProjectInitDeps {
  events?: {
    append(
      sliceId: string,
      type: EventType,
      actor: string,
      payload: Record<string, unknown>,
    ): Promise<unknown>;
  };
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
