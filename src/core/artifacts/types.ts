// Artifact types — outputs produced during slice execution

export type ArtifactType =
  | 'build'
  | 'test-report'
  | 'coverage'
  | 'bundle'
  | 'log'
  | 'generated-code'
  | 'analysis'
  | 'other';

export interface ArtifactData {
  id: string;
  sliceId: string;
  type: ArtifactType;
  label: string;
  path: string;
  hash: string; // sha256
  size: number; // bytes
  mimeType: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}
