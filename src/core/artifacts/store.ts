// Artifact store — file-based persistence in .zelto/artifacts/

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactData, ArtifactType } from './types.js';

export class ArtifactStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = join(baseDir, 'artifacts');
  }

  private path(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }

  async ensureDir(): Promise<void> {
    if (!existsSync(this.baseDir)) {
      await mkdir(this.baseDir, { recursive: true });
    }
  }

  async store(
    sliceId: string,
    type: ArtifactType,
    label: string,
    filePath: string,
    metadata: Record<string, unknown> = {},
  ): Promise<ArtifactData> {
    await this.ensureDir();

    const { readFile: readFileFs, stat } = await import('node:fs/promises');
    const content = await readFileFs(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    const stats = await stat(filePath);

    const artifact: ArtifactData = {
      id: `art-${randomUUID().slice(0, 8)}`,
      sliceId,
      type,
      label,
      path: filePath,
      hash: `sha256:${hash}`,
      size: stats.size,
      mimeType: this.guessMime(filePath),
      createdAt: new Date().toISOString(),
      metadata,
    };

    await writeFile(this.path(artifact.id), JSON.stringify(artifact, null, 2), 'utf-8');
    return artifact;
  }

  async storeBuffer(
    sliceId: string,
    type: ArtifactType,
    label: string,
    buffer: Buffer,
    fileName: string,
    metadata: Record<string, unknown> = {},
  ): Promise<ArtifactData> {
    await this.ensureDir();

    const hash = createHash('sha256').update(buffer).digest('hex');
    const artifact: ArtifactData = {
      id: `art-${randomUUID().slice(0, 8)}`,
      sliceId,
      type,
      label,
      path: fileName,
      hash: `sha256:${hash}`,
      size: buffer.length,
      mimeType: this.guessMime(fileName),
      createdAt: new Date().toISOString(),
      metadata,
    };

    await writeFile(this.path(artifact.id), JSON.stringify(artifact, null, 2), 'utf-8');
    return artifact;
  }

  async read(id: string): Promise<ArtifactData> {
    const data = await readFile(this.path(id), 'utf-8');
    return JSON.parse(data) as ArtifactData;
  }

  async list(sliceId?: string): Promise<ArtifactData[]> {
    await this.ensureDir();

    if (!existsSync(this.baseDir)) return [];

    const files = await readdir(this.baseDir);
    const artifacts: ArtifactData[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(
          await readFile(join(this.baseDir, file), 'utf-8'),
        ) as ArtifactData;
        if (!sliceId || data.sliceId === sliceId) {
          artifacts.push(data);
        }
      } catch {
        // skip corrupt entries
      }
    }

    artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return artifacts;
  }

  async delete(id: string): Promise<void> {
    const p = this.path(id);
    if (existsSync(p)) {
      await unlink(p);
    }
  }

  async deleteBySlice(sliceId: string): Promise<number> {
    const artifacts = await this.list(sliceId);
    for (const a of artifacts) {
      await this.delete(a.id);
    }
    return artifacts.length;
  }

  async verifyHash(id: string, content: Buffer): Promise<boolean> {
    const artifact = await this.read(id);
    const expected = artifact.hash.replace('sha256:', '');
    const actual = createHash('sha256').update(content).digest('hex');
    return expected === actual;
  }

  private guessMime(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      js: 'application/javascript',
      ts: 'application/typescript',
      json: 'application/json',
      md: 'text/markdown',
      html: 'text/html',
      css: 'text/css',
      xml: 'application/xml',
      yaml: 'application/x-yaml',
      yml: 'application/x-yaml',
      png: 'image/png',
      jpg: 'image/jpeg',
      svg: 'image/svg+xml',
      txt: 'text/plain',
      log: 'text/plain',
      zip: 'application/zip',
      tar: 'application/x-tar',
      gz: 'application/gzip',
    };
    return ext ? mimeMap[ext] ?? 'application/octet-stream' : 'application/octet-stream';
  }
}
