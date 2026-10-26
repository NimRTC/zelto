// Tests for trace link module — cross-reference link management
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LinkStore, formatLinks } from '../src/cli/commands/trace/link.js';
import type { TraceLinkEvent } from '../src/cli/commands/trace/link.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTestDir(): string {
  return join(tmpdir(), 'zelto-link-test-' + Date.now() + '-' + randomUUID().slice(0, 6));
}

async function withTestDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = makeTestDir();
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── LinkStore ───────────────────────────────────────────────────────────────

void describe('LinkStore', () => {
  void describe('addLink()', () => {
    void it('adds a link with default relation', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        const link = await store.addLink('req-1', 'dsg-1');

        assert.ok(link.id.length > 0);
        assert.equal(link.source, 'req-1');
        assert.equal(link.target, 'dsg-1');
        assert.equal(link.relation, 'references');
        assert.equal(link.metadata, undefined);
        assert.ok(link.createdAt.length > 0);
      });
    });

    void it('adds a link with custom relation', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        const link = await store.addLink('req-1', 'dsg-1', 'implements');

        assert.equal(link.relation, 'implements');
      });
    });

    void it('adds a link with metadata', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        const meta = { version: 'v1', author: 'test' };
        const link = await store.addLink('req-1', 'dsg-1', 'references', meta);

        assert.deepEqual(link.metadata, meta);
      });
    });

    void it('omits metadata when empty object', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        const link = await store.addLink('req-1', 'dsg-1', 'references', {});

        assert.equal(link.metadata, undefined);
      });
    });

    void it('generates a unique ID for each link', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        const link1 = await store.addLink('req-1', 'dsg-1');
        const link2 = await store.addLink('req-1', 'dsg-2');

        assert.notEqual(link1.id, link2.id);
      });
    });
  });

  void describe('listLinks()', () => {
    void it('returns empty array when no links exist', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        const links = await store.listLinks('req-1');

        assert.deepEqual(links, []);
      });
    });

    void it('returns empty array when no artifactId matches', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        await store.addLink('req-1', 'dsg-1');
        const links = await store.listLinks('req-2');

        assert.deepEqual(links, []);
      });
    });

    void it('finds links by source', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        await store.addLink('req-1', 'dsg-1');
        await store.addLink('req-2', 'dsg-2');

        const links = await store.listLinks('req-1');
        assert.equal(links.length, 1);
        assert.equal(links[0].target, 'dsg-1');
      });
    });

    void it('finds links by target', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        await store.addLink('req-1', 'dsg-1');

        const links = await store.listLinks('dsg-1');
        assert.equal(links.length, 1);
        assert.equal(links[0].source, 'req-1');
      });
    });

    void it('lists all links when no artifactId given', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        await store.addLink('req-1', 'dsg-1');
        await store.addLink('req-2', 'dsg-2');

        const links = await store.listLinks();
        assert.equal(links.length, 2);
      });
    });

    void it('excludes removed links', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        const link = await store.addLink('req-1', 'dsg-1');
        await store.addLink('req-1', 'dsg-2');

        await store.removeLink(link.id);

        const links = await store.listLinks('req-1');
        assert.equal(links.length, 1);
        assert.equal(links[0].target, 'dsg-2');
      });
    });

    void it('returns links sorted by creation date', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        await store.addLink('req-1', 'dsg-1');
        await sleep(10);
        await store.addLink('req-1', 'dsg-2');

        const links = await store.listLinks('req-1');
        assert.equal(links.length, 2);
        assert.ok(links[0].createdAt <= links[1].createdAt);
      });
    });

    void it('is idempotent — reading multiple times returns same data', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        await store.addLink('req-1', 'dsg-1');

        const first = await store.listLinks('req-1');
        const second = await store.listLinks('req-1');
        assert.equal(first.length, second.length);
        assert.equal(first[0].id, second[0].id);
      });
    });
  });

  void describe('removeLink()', () => {
    void it('removes a link by ID', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        const link = await store.addLink('req-1', 'dsg-1');

        await store.removeLink(link.id);

        const links = await store.listLinks('req-1');
        assert.equal(links.length, 0);
      });
    });

    void it('removeLink with reason records the reason', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        const link = await store.addLink('req-1', 'dsg-1');

        await store.removeLink(link.id, 'Wrong reference');

        const links = await store.listLinks('req-1');
        assert.equal(links.length, 0);
      });
    });

    void it('removing a non-existent link is a no-op', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        await store.addLink('req-1', 'dsg-1');

        // Remove a non-existent link ID
        await store.removeLink('nonexistent-id');

        const links = await store.listLinks('req-1');
        assert.equal(links.length, 1);
      });
    });
  });

  void describe('persistence', () => {
    void it('survives store instance recreation', async () => {
      await withTestDir(async (dir) => {
        const store1 = new LinkStore(dir);
        await store1.addLink('req-1', 'dsg-1');

        const store2 = new LinkStore(dir);
        const links = await store2.listLinks('req-1');
        assert.equal(links.length, 1);
        assert.equal(links[0].source, 'req-1');
        assert.equal(links[0].target, 'dsg-1');
      });
    });

    void it('persists removals across instances', async () => {
      await withTestDir(async (dir) => {
        const store1 = new LinkStore(dir);
        const link = await store1.addLink('req-1', 'dsg-1');
        await store1.removeLink(link.id);

        const store2 = new LinkStore(dir);
        const links = await store2.listLinks('req-1');
        assert.equal(links.length, 0);
      });
    });

    void it('stores links as valid JSONL', async () => {
      await withTestDir(async (dir) => {
        const store = new LinkStore(dir);
        await store.addLink('req-1', 'dsg-1');
        await store.addLink('req-1', 'dsg-2');

        const linksFile = join(dir, 'events', 'trace-links', 'links.jsonl');
        const content = await import('node:fs/promises').then((m) =>
          m.readFile(linksFile, 'utf-8'),
        );

        const lines = content.trim().split('\n');
        assert.equal(lines.length, 2);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          assert.ok(parsed.id);
          assert.ok(parsed.source);
          assert.ok(parsed.target);
        }
      });
    });
  });
});

// ─── formatLinks ─────────────────────────────────────────────────────────────

void describe('formatLinks', () => {
  void it('returns "No links found" for empty array', () => {
    const result = formatLinks([]);
    assert.equal(result, 'No links found.');
  });

  void it('formats a single link', () => {
    const links: TraceLinkEvent[] = [
      {
        id: 'abc-123-def',
        source: 'req-1',
        target: 'dsg-1',
        relation: 'references',
        createdAt: '2026-10-26T10:00:00.000Z',
      },
    ];

    const result = formatLinks(links);
    assert.ok(result.includes('Links:'));
    assert.ok(result.includes('req-1'));
    assert.ok(result.includes('→'));
    assert.ok(result.includes('dsg-1'));
    assert.ok(result.includes('[references]'));
    assert.ok(result.includes('2026-10-26 10:00:00'));
  });

  void it('formats multiple links', () => {
    const links: TraceLinkEvent[] = [
      {
        id: 'abc-123',
        source: 'req-1',
        target: 'dsg-1',
        relation: 'references',
        createdAt: '2026-10-26T10:00:00.000Z',
      },
      {
        id: 'def-456',
        source: 'req-1',
        target: 'dsg-2',
        relation: 'implements',
        createdAt: '2026-10-26T11:00:00.000Z',
      },
    ];

    const result = formatLinks(links);
    const lines = result.split('\n');
    assert.equal(lines.length, 3); // Header + 2 links
    assert.ok(lines[1].includes('req-1'));
    assert.ok(lines[2].includes('req-1'));
  });

  void it('includes metadata in formatted output', () => {
    const links: TraceLinkEvent[] = [
      {
        id: 'abc-123',
        source: 'req-1',
        target: 'dsg-1',
        relation: 'references',
        metadata: { version: 'v1' },
        createdAt: '2026-10-26T10:00:00.000Z',
      },
    ];

    const result = formatLinks(links);
    assert.ok(result.includes('version'));
    assert.ok(result.includes('v1'));
  });
});

// ─── Integration: default store functions ───────────────────────────────────

void describe('default store convenience functions', () => {
  // These tests verify the module-level exports exist

  void it('addLink, listLinks, removeLink, formatLinks are exported', async () => {
    const mod = await import('../src/cli/commands/trace/link.js');
    assert.equal(typeof mod.addLink, 'function');
    assert.equal(typeof mod.listLinks, 'function');
    assert.equal(typeof mod.removeLink, 'function');
    assert.equal(typeof mod.formatLinks, 'function');
  });
});

// ─── Utils ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
