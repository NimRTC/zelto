// Version types

export type VersionStatus = 'planned' | 'in_progress' | 'integrated' | 'delivered';

export interface VersionSlice {
  id: string;
  module: string;
  title: string;
  writes: string[];
  specPath: string;
  state?: string;
}

export interface Version {
  version: string;
  dependsOn: string[];
  description: string;
  slices: VersionSlice[];
  integrationTestDir: string;
  status: VersionStatus;
  /** 版本分支名；缺省派生为 `version/<label>` */
  branch?: string;
  /** 版本分支的基点 commit（建分支时的主干 HEAD） */
  baseCommit?: string | null;
  /** 版本 tag 名；缺省派生为 `v<label>`（ADR-056 D6） */
  tag?: string;
}

export interface VersionPlan {
  id: string;
  designId: string;
  title: string;
  versions: Version[];
  status: 'draft' | 'confirmed';
  createdAt: string;
  confirmedAt: string | null;
}

export interface VersionSummary {
  id: string;
  title: string;
  versionCount: number;
  status: 'draft' | 'confirmed';
  createdAt: string;
}
