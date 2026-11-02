import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface ReleaseDef {
  version: string;
  title: string;
  description: string;
  status: 'completed' | 'in_progress' | 'planned' | 'cancelled';
  plans: string[];
}

const ZELTO_DIR = '.zelto';

export function loadReleases(): ReleaseDef[] {
  const releasesPath = join(ZELTO_DIR, 'releases.yaml');
  if (!existsSync(releasesPath)) return [];
  try {
    const content = readFileSync(releasesPath, 'utf-8');
    return parseReleasesYaml(content);
  } catch {
    return [];
  }
}

export function parseReleasesYaml(content: string): ReleaseDef[] {
  const releases: ReleaseDef[] = [];
  let current: Partial<ReleaseDef> | null = null;
  let inPlans = false;

  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (line.trim() === 'releases:') continue;

    const versionMatch = line.match(/^\s+-\s+version:\s*(.+)$/);
    if (versionMatch) {
      if (current && current.version) releases.push(current as ReleaseDef);
      current = { version: versionMatch[1].trim(), plans: [] };
      inPlans = false;
      continue;
    }

    if (!current) continue;

    const titleMatch = line.match(/^\s+title:\s*(.+)$/);
    if (titleMatch) { current.title = stripQuotes(titleMatch[1].trim()); continue; }

    const descMatch = line.match(/^\s+description:\s*(.+)$/);
    if (descMatch) { current.description = stripQuotes(descMatch[1].trim()); continue; }

    const statusMatch = line.match(/^\s+status:\s*(.+)$/);
    if (statusMatch) { current.status = statusMatch[1].trim() as ReleaseDef['status']; continue; }

    if (line.trim() === 'plans:') { inPlans = true; continue; }

    const planMatch = line.match(/^\s+-\s+(.+)$/);
    if (inPlans && planMatch) {
      current.plans!.push(planMatch[1].trim());
    }
  }

  if (current && current.version) releases.push(current as ReleaseDef);
  return releases;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}
