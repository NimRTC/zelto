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
