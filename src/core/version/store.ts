// VersionStore — file-based persistence for version plans
// Stored as JSON in .zelto/versions/<id>.json

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { VersionPlan, VersionStatus, VersionSummary } from './types.js';

export class VersionStore {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'versions');
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  async save(plan: VersionPlan): Promise<void> {
    this.ensureDir();
    const filePath = join(this.dir, `${plan.id}.json`);
    writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
  }

  async read(id: string): Promise<VersionPlan> {
    const filePath = join(this.dir, `${id}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Version plan "${id}" not found`);
    }
    return JSON.parse(readFileSync(filePath, 'utf-8')) as VersionPlan;
  }

  async list(): Promise<VersionSummary[]> {
    this.ensureDir();
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const summaries: VersionSummary[] = [];

    for (const file of files) {
      try {
        const plan = await this.read(file.replace(/\.json$/, ''));
        summaries.push({
          id: plan.id,
          title: plan.title,
          versionCount: plan.versions.length,
          status: plan.status,
          createdAt: plan.createdAt,
        });
      } catch {
        // skip unreadable files
      }
    }

    return summaries.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async updateVersionStatus(
    planId: string,
    version: string,
    status: VersionStatus,
  ): Promise<VersionPlan> {
    const plan = await this.read(planId);
    const v = plan.versions.find((v) => v.version === version);
    if (!v) throw new Error(`Version "${version}" not found in plan "${planId}"`);
    v.status = status;
    await this.save(plan);
    return plan;
  }

  async exists(id: string): Promise<boolean> {
    return existsSync(join(this.dir, `${id}.json`));
  }
}
