// ????????? ???????????????ADR-133 ???
//
// ??????????
//
//   1. **?????** ?? ????????????
//   2. **?????????** ?? ?????????? + ?????
//   3. **? agent ??? allow_always** ?? ?????? zelto ??
//      ?? agent ?? allow_always ???????????? zelto?
//
// ????? `tests/hook/acp.test.ts` ????? allow_always????
// ?????**??? zelto ?**????

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { judgeAlwaysGrant, pathInAllowlist } from '../src/hook/acp-always.js';
import type { PreToolContext } from '../src/hook/pretool.js';
import {
  addGrant,
  grantsPath,
  hasGrant,
  loadGrants,
  saveGrants,
} from '../src/adapters/acp/always-grants.js';
import { loadConfigAt } from '../src/core/config/loader.js';

const CTX: PreToolContext = {
  projectRoot: '/repo',
  worktreeRoot: '/repo/wt',
  sliceId: 's1',
  writes: ['src/**'],
  rules: null,
  policyVersion: 'sha256:test',
};

describe('allow_always ?? ?? ?????', () => {
  it('????? -> ????', () => {
    const d = judgeAlwaysGrant(['src/a.ts'], CTX, undefined);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, 'not-in-allowlist');
  });

  it('??????? -> ????', () => {
    const d = judgeAlwaysGrant(['src/a.ts'], CTX, []);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, 'not-in-allowlist');
  });

  it('?????????? -> ????', () => {
    const d = judgeAlwaysGrant(['src/a.ts'], CTX, ['docs/**']);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, 'not-in-allowlist');
  });
});

describe('allow_always ?? ?? ?????????', () => {
  it('??????? -> ?????????????', () => {
    const d = judgeAlwaysGrant(['other/x.txt'], CTX, ['**']);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, 'not-in-write-set');
  });

  it('?????????? -> ????', () => {
    const d = judgeAlwaysGrant(['src/a.ts'], { ...CTX, writes: null }, ['src/**']);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, 'not-in-write-set');
  });

  it('????? worktree -> ????', () => {
    const d = judgeAlwaysGrant(['../../etc/passwd'], CTX, ['**']);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, 'not-in-write-set');
  });

  it('??? + ???? -> ????', () => {
    const d = judgeAlwaysGrant(['src/a.ts'], CTX, ['src/**']);
    assert.equal(d.eligible, true);
    assert.equal(d.path, 'src/a.ts');
  });
});

describe('allow_always ?? ?? ??????', () => {
  it('?????????? -> ???', () => {
    // ?????????????????? ?? ???????
    const d = judgeAlwaysGrant(['src/a.ts', 'src/b.ts'], CTX, ['src/**']);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, 'no-path');
  });

  it('??? -> ???', () => {
    const d = judgeAlwaysGrant([], CTX, ['src/**']);
    assert.equal(d.eligible, false);
  });
});

describe('?????', () => {
  it('????', () => {
    assert.equal(pathInAllowlist('src/a.ts', ['src/a.ts']), true);
    assert.equal(pathInAllowlist('src/b.ts', ['src/a.ts']), false);
  });

  it('????', () => {
    assert.equal(pathInAllowlist('src/gen/x.ts', ['src/gen']), true);
    assert.equal(pathInAllowlist('src/gen/x.ts', ['src/gen/']), true);
    assert.equal(pathInAllowlist('src/other/x.ts', ['src/gen']), false);
  });

  it('glob', () => {
    assert.equal(pathInAllowlist('src/gen/x.ts', ['src/**']), true);
    assert.equal(pathInAllowlist('other/x.ts', ['src/**']), false);
  });

  it('?????????', () => {
    assert.equal(pathInAllowlist('src/a.ts', ['', '   ']), false);
  });

  it('??????????????????', () => {
    // `src/gen` ???? `src/generate/x.ts` ?? ????????
    assert.equal(pathInAllowlist('src/generate/x.ts', ['src/gen']), false);
  });
});

describe('???? ?? ?? zelto ??C1?????????', () => {
  function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'zelto-always-'));
  }

  it('???????? -> ???', () => {
    const root = tmpRoot();
    try {
      assert.deepEqual(loadGrants(root, 's1'), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('???????', () => {
    const root = tmpRoot();
    try {
      addGrant(root, 's1', { path: 'src/a.ts', source: 'acp:cursor-agent acp' });
      const grants = loadGrants(root, 's1');
      assert.equal(grants.length, 1);
      assert.equal(grants[0].path, 'src/a.ts');
      assert.equal(grants[0].sliceId, 's1');
      assert.ok(grants[0].grantedAt, '???????');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('????????????', () => {
    const root = tmpRoot();
    try {
      addGrant(root, 's1', { path: 'src/a.ts', source: 'x' });
      addGrant(root, 's1', { path: 'src/a.ts', source: 'y' });
      assert.equal(loadGrants(root, 's1').length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('?????? ?? ??????', () => {
    const root = tmpRoot();
    try {
      addGrant(root, 's1', { path: 'src/a.ts', source: 'x' });
      assert.equal(loadGrants(root, 's1').length, 1);
      assert.equal(loadGrants(root, 's2').length, 0, '?????????????');
      assert.notEqual(grantsPath(root, 's1'), grantsPath(root, 's2'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('???????????? glob', () => {
    // ???? src/a.ts????????????? src/??
    const root = tmpRoot();
    try {
      addGrant(root, 's1', { path: 'src/a.ts', source: 'x' });
      assert.equal(hasGrant(loadGrants(root, 's1'), 'src/a.ts'), true);
      assert.equal(hasGrant(loadGrants(root, 's1'), 'src/b.ts'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('???? -> ???????', () => {
    const root = tmpRoot();
    try {
      saveGrants(root, 's1', []);
      mkdirSync(join(root, '.zelto', 'locks'), { recursive: true });
      writeFileSync(grantsPath(root, 's1'), '{ not json', 'utf-8');
      assert.deepEqual(loadGrants(root, 's1'), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('?????? -> ????', () => {
    const root = tmpRoot();
    try {
      mkdirSync(join(root, '.zelto', 'locks'), { recursive: true });
      writeFileSync(
        grantsPath(root, 's1'),
        JSON.stringify({
          grants: [{ path: 123 }, { path: 'ok.ts', sliceId: 's1', grantedAt: 'x', source: 'y' }],
        }),
        'utf-8',
      );
      const grants = loadGrants(root, 's1');
      assert.equal(grants.length, 1);
      assert.equal(grants[0].path, 'ok.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('?? ?? agent.acp.alwaysAllowPaths', () => {
  /**
   * ???? `.zelto/config.yaml` ???????
   *
   * **??? gate ?** ?? loader ??????`parseConfigYaml` ???
   * ??? gate ?? / ? llm / ? web / ? ???????
   * ?? `agent:` ??????**????**????????
   *
   * ?? loader ?**????**????????? ??
   * ????? config.yaml ?? gate ??????????
   * ?????? gate ???????????????????
   */
  function makeRepo(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'zelto-cfg-'));
    mkdirSync(join(dir, '.zelto'), { recursive: true });
    writeFileSync(join(dir, '.zelto', 'config.yaml'), yaml, 'utf-8');
    return dir;
  }

  /** ????? gate ??? loader ??????? */
  const GATE = ['gate:', '  commands:', '    - name: test', '      run: echo hi', ''].join('\n');

  it('????????= ???', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zelto-cfg-'));
    try {
      const cfg = loadConfigAt(dir);
      assert.equal(cfg.agent.acp?.alwaysAllowPaths, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('?????', () => {
    const dir = makeRepo(
      [
        GATE,
        'agent:',
        '  adapter: acp',
        '  acp:',
        '    command: cursor-agent acp',
        '    alwaysAllowPaths:',
        '      - src/generated/**',
        '      - docs/',
        '',
      ].join('\n'),
    );
    try {
      const cfg = loadConfigAt(dir);
      assert.deepEqual(cfg.agent.acp?.alwaysAllowPaths, ['src/generated/**', 'docs/']);
      assert.equal(cfg.agent.acp?.command, 'cursor-agent acp');
      assert.equal(cfg.agent.adapter, 'acp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('??????', () => {
    const dir = makeRepo(
      [GATE, 'agent:', '  acp:', '    alwaysAllowPaths: [a/**, b/**]', ''].join('\n'),
    );
    try {
      const cfg = loadConfigAt(dir);
      assert.deepEqual(cfg.agent.acp?.alwaysAllowPaths, ['a/**', 'b/**']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('?? command ??? alwaysAllowPaths -> ??????', () => {
    const dir = makeRepo(
      [GATE, 'agent:', '  acp:', '    command: cursor-agent acp', ''].join('\n'),
    );
    try {
      const cfg = loadConfigAt(dir);
      assert.equal(cfg.agent.acp?.command, 'cursor-agent acp');
      assert.equal(cfg.agent.acp?.alwaysAllowPaths, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('alwaysAllowPaths ???? agent ??????', () => {
    const dir = makeRepo(
      [
        GATE,
        'agent:',
        '  command: npx claude-code',
        '  maxRetries: 5',
        '  acp:',
        '    alwaysAllowPaths:',
        '      - src/**',
        '  timeout: 600',
        '',
      ].join('\n'),
    );
    try {
      const cfg = loadConfigAt(dir);
      assert.deepEqual(cfg.agent.acp?.alwaysAllowPaths, ['src/**']);
      assert.equal(cfg.agent.maxRetries, 5, 'maxRetries ????');
      assert.equal(cfg.agent.timeout, 600, 'timeout ????');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
