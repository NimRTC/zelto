// Cross-reference link management for the trace command
// Stores links as append-only JSONL in .zelto/events/trace-links/
// C4: every action is an append-only event

import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZELTO_DIR } from '../shared.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TraceLinkEvent {
  id: string;
  source: string;
  target: string;
  relation: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

// ─── Link Store ──────────────────────────────────────────────────────────────

export class LinkStore {
  private readonly linksFile: string;
  private readonly removalsFile: string;

  /**
   * @param baseDir Path to .zelto directory (defaults to ZELTO_DIR constant)
   */
  constructor(baseDir: string = ZELTO_DIR) {
    this.linksFile = join(baseDir, 'events', 'trace-links', 'links.jsonl');
    this.removalsFile = join(baseDir, 'events', 'trace-links', 'removals.jsonl');
  }

  private async ensureDir(): Promise<void> {
    const dir = dirname(this.linksFile);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Append a new link record to the JSONL store.
   */
  async addLink(
    source: string,
    target: string,
    relation: string = 'references',
    metadata?: Record<string, string>,
  ): Promise<TraceLinkEvent> {
    await this.ensureDir();

    const link: TraceLinkEvent = {
      id: randomUUID(),
      source,
      target,
      relation,
      metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
      createdAt: new Date().toISOString(),
    };

    await appendFile(this.linksFile, JSON.stringify(link) + '\n', 'utf-8');
    return link;
  }

  /**
   * Append a removal tombstone for a link.
   */
  async removeLink(linkId: string, reason?: string): Promise<void> {
    await this.ensureDir();

    const record = { linkId, reason, createdAt: new Date().toISOString() };
    await appendFile(this.removalsFile, JSON.stringify(record) + '\n', 'utf-8');
  }

  /**
   * List all links, optionally filtered to those involving an artifact.
   * Excludes links that have been removed.
   */
  async listLinks(artifactId?: string): Promise<TraceLinkEvent[]> {
    const allLinks = await this.readAllLinks();
    if (allLinks.length === 0) return [];

    const removedIds = await this.readRemovedIds();

    let filtered = artifactId
      ? allLinks.filter((l) => l.source === artifactId || l.target === artifactId)
      : allLinks;

    if (removedIds.size > 0) {
      filtered = filtered.filter((l) => !removedIds.has(l.id));
    }

    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async readAllLinks(): Promise<TraceLinkEvent[]> {
    try {
      const content = await readFile(this.linksFile, 'utf-8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TraceLinkEvent);
    } catch {
      return [];
    }
  }

  private async readRemovedIds(): Promise<Set<string>> {
    try {
      const content = await readFile(this.removalsFile, 'utf-8');
      const ids = content
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line).linkId;
          } catch {
            return null;
          }
        })
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      return new Set(ids);
    } catch {
      return new Set();
    }
  }
}

// ─── Convenience Functions (use default ZELTO_DIR) ───────────────────────────

const defaultStore = new LinkStore();

/**
 * Add a cross-reference link between two artifacts.
 */
export async function addLink(
  source: string,
  target: string,
  relation?: string,
  metadata?: Record<string, string>,
): Promise<TraceLinkEvent> {
  return defaultStore.addLink(source, target, relation, metadata);
}

/**
 * List all links involving a given artifact.
 */
export async function listLinks(artifactId: string): Promise<TraceLinkEvent[]> {
  return defaultStore.listLinks(artifactId);
}

/**
 * Remove a link by its event ID (append-only tombstone).
 */
export async function removeLink(linkId: string, reason?: string): Promise<void> {
  return defaultStore.removeLink(linkId, reason);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format a list of links for CLI output.
 */
export function formatLinks(links: TraceLinkEvent[]): string {
  if (links.length === 0) {
    return 'No links found.';
  }

  const rows = links.map((l) => {
    const meta = l.metadata ? ` ${JSON.stringify(l.metadata)}` : '';
    const created = l.createdAt.slice(0, 19).replace('T', ' ');
    return `  ${l.id.slice(0, 8)}  ${l.source} → ${l.target}  [${l.relation}]${meta}  (${created})`;
  });

  return `Links:\n${rows.join('\n')}`;
}
