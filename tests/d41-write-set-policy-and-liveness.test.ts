// D-41 · 写集与策略/真实路径的一致性 + Windows 进程树活性判定（单测）
//
// 三个病灶，全部实测于 nimrtc-zelto v2 演练（2026-11-17）：
//
//   ① 门禁①不校验「写集 × policy.yaml」的交集 —— 一片从一开始就注定
//      写不进任何文件的切片被放进了跑批，agent 一路被拒到超时。
//   ② 写集路径写错（少了一层 `include/nimrtc/xxx/`）时，门禁①只说
//      「agent 会新建」—— 而 agent 找到真实文件去改就被 hook 拒绝。
//   ③ 活性判定只看外层 `cmd.exe` 的 pid，真正的 agent（claude.exe）是
//      孙进程 → 误判「死」→ 同一个 worktree 上起了第二个 agent。
//
// 判据都在 core/ 里，这里锁死边界。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { evaluateWriteSet } from '../src/core/spec/write-set.js';
import { evaluateWriteSetAgainstPolicy } from '../src/core/spec/write-set-policy.js';
import { classifyLiveness, classifyLivenessAsync } from '../src/core/activity/liveness.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const NOW = Date.now();

// ─── ① 写集 × 策略 ───────────────────────────────────────────────────────────

/** nimrtc-zelto 的 policy.yaml 简化版（真实结构）。 */
const nimrtcPolicy: PolicyConfig = {
  rules: [
    { id: 'allow-src', match: { path: 'src/**', operation: 'write' }, action: 'allow', basis: 'p' },
    { id: 'allow-examples', match: { path: 'examples/**', operation: 'write' }, action: 'allow', basis: 'p' },
    { id: 'allow-tests', match: { path: 'tests/**', operation: 'write' }, action: 'allow', basis: 'p' },
    { id: 'allow-tools', match: { path: 'tools/**', operation: 'write' }, action: 'allow', basis: 'p' },
    { id: 'allow-docs', match: { path: 'docs/**', operation: 'write' }, action: 'allow', basis: 'p' },
    { id: 'protect-policy', match: { path: 'policy/**' }, action: 'deny', basis: 'p' },
  ],
  protected: ['policy/**', '.zelto/**', 'AGENTS.md'],
};

describe('D-41① · 写集 × policy.yaml 的交集判定', () => {
  it('写集在允许规则内 → 无冲突', () => {
    const r = evaluateWriteSetAgainstPolicy(['src/modules/rd_input/**'], nimrtcPolicy);
    assert.equal(r.conflicts.length, 0);
    assert.equal(r.advisories.length, 0);
  });

  it('写集完全不被任何 allow 规则覆盖 → 阻断（这就是 v2-ai-decision 的病灶）', () => {
    const r = evaluateWriteSetAgainstPolicy(['demo-agent-realtime/**'], nimrtcPolicy);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].severity, 'blocking');
    assert.equal(r.conflicts[0].write, 'demo-agent-realtime/**');
    // 提示语要说清「第一次写就会被拒」，而不是笼统的「不合规」
    assert.match(r.conflicts[0].message, /第一次写文件就会被拒/);
  });

  it('写集命中 deny 规则 → 阻断', () => {
    const r = evaluateWriteSetAgainstPolicy(['policy/lock.json'], nimrtcPolicy);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].ruleId, 'protect-policy');
  });

  it('写集命中 ask 规则 → 提示（不阻断）', () => {
    const policy: PolicyConfig = {
      rules: [
        { id: 'ask-x', match: { path: 'src/**', operation: 'write' }, action: 'ask', basis: 'p' },
      ],
      protected: [],
    };
    const r = evaluateWriteSetAgainstPolicy(['src/a.cpp'], policy);
    assert.equal(r.conflicts.length, 0);
    assert.equal(r.advisories.length, 1);
    assert.equal(r.advisories[0].ruleId, 'ask-x');
  });

  it('写集里一条合规一条不合规 → 仍然阻断（合规的那条不能掩盖不合规的）', () => {
    const r = evaluateWriteSetAgainstPolicy(
      ['src/ok.cpp', 'demo-agent-realtime/**'],
      nimrtcPolicy,
    );
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].write, 'demo-agent-realtime/**');
  });

  it('没有策略 → 不判冲突（写集是唯一判据）', () => {
    const r = evaluateWriteSetAgainstPolicy(['anything/**'], null);
    assert.equal(r.conflicts.length, 0);
  });

  it('glob 写集与字面 allow 规则能对上（examples/demo-x/** 落在 examples/** 内）', () => {
    const r = evaluateWriteSetAgainstPolicy(['examples/demo-agent-realtime/**'], nimrtcPolicy);
    assert.equal(r.conflicts.length, 0);
  });

  it('反向也成立：规则比写集宽（写集 examples/**、规则 examples/demo/**）→ 有交集', () => {
    const policy: PolicyConfig = {
      rules: [
        { id: 'allow-demo', match: { path: 'examples/demo/**', operation: 'write' }, action: 'allow', basis: 'p' },
      ],
      protected: [],
    };
    const r = evaluateWriteSetAgainstPolicy(['examples/**'], policy);
    assert.equal(r.conflicts.length, 0);
  });

  it('两条 glob 只是字面同名、方向并不重合 → 不算交集（src/** vs x/src/**）', () => {
    const policy: PolicyConfig = {
      rules: [
        { id: 'allow-x-src', match: { path: 'x/src/**', operation: 'write' }, action: 'allow', basis: 'p' },
      ],
      protected: [],
    };
    const r = evaluateWriteSetAgainstPolicy(['src/**'], policy);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].severity, 'blocking');
  });

  it('写集是具体文件、规则是它的父目录 → 不算交集（目录规则不覆盖其下文件的写）', () => {
    const policy: PolicyConfig = {
      rules: [
        { id: 'allow-examples-dir', match: { path: 'examples', operation: 'write' }, action: 'allow', basis: 'p' },
      ],
      protected: [],
    };
    const r = evaluateWriteSetAgainstPolicy(['examples/CMakeLists.txt'], policy);
    assert.equal(r.conflicts.length, 1);
  });
});

// ─── ② 写集路径写错的近名提示 ─────────────────────────────────────────────────

describe('D-41② · 写集路径写错时的近名提示', () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'zelto-ws-'));
    mkdirSync(join(root, 'src/modules/rd_input/include/nimrtc/rd_input'), { recursive: true });
    mkdirSync(join(root, 'src/modules/rd_input/src'), { recursive: true });
    writeFileSync(
      join(root, 'src/modules/rd_input/include/nimrtc/rd_input/ref_frame_binder.hpp'),
      '// real\n',
    );
    writeFileSync(join(root, 'src/modules/rd_input/src/event_codec.cpp'), '// real\n');
    return root;
  }

  it('写集路径不存在但同名文件在别处 → 报近名候选（v2-input-binder 的病灶）', () => {
    const root = makeRepo();
    try {
      const r = evaluateWriteSet({
        writes: ['src/modules/rd_input/ref_frame_binder.hpp'],
        projectRoot: root,
      });
      assert.equal(r.nearMisses.length, 1);
      assert.equal(r.nearMisses[0].path, 'src/modules/rd_input/ref_frame_binder.hpp');
      assert.ok(
        r.nearMisses[0].candidates.includes('src/modules/rd_input/include/nimrtc/rd_input/ref_frame_binder.hpp'),
      );
      // 提示要说清「agent 会被拒」这件事
      assert.ok(r.advisories.some((a) => a.includes('likely wrong')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('写集路径真实存在 → 不报近名', () => {
    const root = makeRepo();
    try {
      const r = evaluateWriteSet({
        writes: ['src/modules/rd_input/src/event_codec.cpp'],
        projectRoot: root,
      });
      assert.equal(r.nearMisses.length, 0);
      assert.deepEqual(r.existing, ['src/modules/rd_input/src/event_codec.cpp']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('真正的新建文件（仓库里没有同名文件）→ 不报近名', () => {
    const root = makeRepo();
    try {
      const r = evaluateWriteSet({
        writes: ['src/modules/rd_input/brand_new.hpp'],
        projectRoot: root,
      });
      assert.equal(r.nearMisses.length, 0);
      assert.deepEqual(r.toCreate, ['src/modules/rd_input/brand_new.hpp']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── ③ 进程树活性判定 ─────────────────────────────────────────────────────────

describe('D-41③ · Windows 上「包装进程死了但 agent 还活着」', () => {
  it('有 agentPid 时以它为准：agentPid 活着 → active', () => {
    const live = classifyLiveness(
      {
        status: 'running',
        pid: 48092,          // 外层 cmd.exe
        agentPid: 40548,     // 真正的 claude.exe
        lastActivityAt: new Date(NOW - 5_000).toISOString(),
      },
      {
        now: NOW,
        isProcessAlive: (pid) => pid === 40548,
      },
    );
    assert.equal(live.state, 'active');
  });

  it('包装 pid 死了但整棵树还有活着的后代 → 不判死（同步版，走 isProcessTreeAlive）', () => {
    const live = classifyLiveness(
      {
        status: 'running',
        pid: 48092,
        lastActivityAt: new Date(NOW - 5_000).toISOString(),
      },
      {
        now: NOW,
        isProcessAlive: () => false,
        isProcessTreeAlive: () => true,
      },
    );
    assert.equal(live.state, 'active');
  });

  it('包装 pid 死了且整棵树都死了 → dead', () => {
    const live = classifyLiveness(
      {
        status: 'running',
        pid: 48092,
        lastActivityAt: new Date(NOW - 5_000).toISOString(),
      },
      {
        now: NOW,
        isProcessAlive: () => false,
        isProcessTreeAlive: () => false,
      },
    );
    assert.equal(live.state, 'dead');
  });

  it('异步版：包装进程没了但树还活着 → active', async () => {
    const live = await classifyLivenessAsync(
      {
        status: 'running',
        pid: 48092,
        lastActivityAt: new Date(NOW - 5_000).toISOString(),
      },
      {
        now: NOW,
        isProcessAlive: () => false,
        isProcessTreeAlive: async () => true,
      },
    );
    assert.equal(live.state, 'active');
    assert.match(live.reason, /进程树还在运行/);
  });

  it('异步版：树也死了 → dead', async () => {
    const live = await classifyLivenessAsync(
      {
        status: 'running',
        pid: 48092,
        lastActivityAt: new Date(NOW - 5_000).toISOString(),
      },
      {
        now: NOW,
        isProcessAlive: () => false,
        isProcessTreeAlive: async () => false,
      },
    );
    assert.equal(live.state, 'dead');
  });

  it('异步版：树还活着但很久没动静 → stale（可疑，不是死）', async () => {
    const live = await classifyLivenessAsync(
      {
        status: 'running',
        pid: 48092,
        lastActivityAt: new Date(NOW - 600_000).toISOString(),
      },
      {
        now: NOW,
        isProcessAlive: () => false,
        isProcessTreeAlive: async () => true,
      },
    );
    assert.equal(live.state, 'stale');
  });
});
