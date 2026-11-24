// ZD-009：门禁命令的阶段（配置 → 编译 → 测试）
//
// 病灶（nimrtc v1.4，2026-11-20）：
//
//   ZD-008 修好（子模块同步）、构建树配好之后，第一次跑 `zelto gate` 又撞上一个：
//   门禁的 build 命令是 `cmake --build build`，但 `build/` **从来不存在** ——
//   **配置步骤没人做**。
//
//   根因：C++ 项目「配一次、用很多次」，但 zelto 不知道这件事。
//   门禁命令只有「一条条按配置顺序跑」这一个语义 —— 没有「这三条是
//   同一道工序的三个阶段」这层意思。
//
// 修法：给门禁命令加一个 `phase` 字段（configure / build / test），
// 门禁按阶段排序执行。
//
// 关键约束：**没写 phase 的命令，行为完全不变**（顺序也不变）——
// 排序是**稳定**的，且没写 phase 的全落在 `default` 阶段。
//
// C3：纯计算（排序只是数组重排），不调模型、不触网。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { orderGateCommands, gatePhaseOf } from '../src/core/gate/types.js';
import { parseConfigYaml } from '../src/core/config/loader.js';
import type { GateCommand } from '../src/core/gate/types.js';

describe('ZD-009 · 门禁命令的阶段排序', () => {
  it('按 configure → default → build → test 排', () => {
    const cmds: GateCommand[] = [
      { name: 'test', run: 'ctest', phase: 'test' },
      { name: 'build', run: 'cmake --build build', phase: 'build' },
      { name: 'configure', run: 'cmake -S . -B build', phase: 'configure' },
    ];
    assert.deepEqual(
      orderGateCommands(cmds).map((c) => c.name),
      ['configure', 'build', 'test'],
    );
  });

  it('没写 phase 的命令全落在 default 阶段', () => {
    assert.equal(gatePhaseOf({ name: 'x', run: 'y' }), 'default');
  });

  it('**没写 phase 时顺序完全不变**（零行为变化）', () => {
    const cmds: GateCommand[] = [
      { name: 'test', run: 'ctest' },
      { name: 'lint', run: 'biome check' },
      { name: 'build', run: 'tsc' },
    ];
    assert.deepEqual(
      orderGateCommands(cmds).map((c) => c.name),
      ['test', 'lint', 'build'],
    );
  });

  it('同阶段内**保序**（稳定排序）', () => {
    const cmds: GateCommand[] = [
      { name: 't1', run: 'a', phase: 'test' },
      { name: 't2', run: 'b', phase: 'test' },
      { name: 't3', run: 'c', phase: 'test' },
    ];
    assert.deepEqual(
      orderGateCommands(cmds).map((c) => c.name),
      ['t1', 't2', 't3'],
    );
  });

  it('混合：写了 phase 的按阶段走，没写的落在 default', () => {
    const cmds: GateCommand[] = [
      { name: 'lint', run: 'biome check' },
      { name: 'test', run: 'ctest', phase: 'test' },
      { name: 'configure', run: 'cmake -S . -B build', phase: 'configure' },
    ];
    assert.deepEqual(
      orderGateCommands(cmds).map((c) => c.name),
      ['configure', 'lint', 'test'],
    );
  });

  it('不改动原数组（纯函数）', () => {
    const cmds: GateCommand[] = [
      { name: 'test', run: 'ctest', phase: 'test' },
      { name: 'configure', run: 'cmake', phase: 'configure' },
    ];
    orderGateCommands(cmds);
    assert.equal(cmds[0].name, 'test', '原数组顺序不该被改');
  });
});

describe('ZD-009 · config.yaml 的 phase 解析', () => {
  it('能读出命令的阶段', () => {
    const parsed = parseConfigYaml(`
gate:
  commands:
    - name: configure
      run: cmake -S . -B build -G "Visual Studio 17 2022"
      phase: configure
    - name: build
      run: cmake --build build --config Debug
      phase: build
    - name: test
      run: ctest --test-dir build -C Debug
      phase: test
`);
    assert.ok(parsed);
    assert.equal(parsed.gate.commands.length, 3);
    assert.equal(parsed.gate.commands[0].phase, 'configure');
    assert.equal(parsed.gate.commands[1].phase, 'build');
    assert.equal(parsed.gate.commands[2].phase, 'test');
  });

  it('没写 phase → 不带这个字段（老行为）', () => {
    const parsed = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: npm test
`);
    assert.ok(parsed);
    assert.equal(parsed.gate.commands[0].phase, undefined);
  });

  it('profile 里的命令也能带阶段', () => {
    const parsed = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: npm test
  profiles:
    code:
      - name: configure
        run: cmake -S . -B build
        phase: configure
      - name: build
        run: cmake --build build
        phase: build
`);
    assert.ok(parsed);
    assert.equal(parsed.gate.profiles?.code?.[0].phase, 'configure');
    assert.equal(parsed.gate.profiles?.code?.[1].phase, 'build');
  });

  it('**不认识的阶段名报错**（不静默当默认值）', () => {
    assert.throws(
      () =>
        parseConfigYaml(`
gate:
  commands:
    - name: build
      run: cmake --build build
      phase: buidl
`),
      /phase: "buidl" 不认识/,
    );
  });

  it('`phase: default` 报错（那是内部落点，不是人能写的值）', () => {
    assert.throws(
      () =>
        parseConfigYaml(`
gate:
  commands:
    - name: build
      run: cmake --build build
      phase: default
`),
      /phase: "default" 不认识/,
    );
  });
});
