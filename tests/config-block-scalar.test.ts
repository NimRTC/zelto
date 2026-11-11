// Tests for YAML block scalar support in `.zelto/config.yaml`
//
// 背景：人写多行门禁命令时，YAML 的惯用写法是折叠标量 `>`。
// 之前的解析器只认单行 `run: <一行>`，于是 `run: >` 被读成字面量 ">"，
// 门禁拿到的命令就是 ">"，报错完全指不到真正的原因。
//
// 这里覆盖：
//   - 折叠标量 `>` / `>-`（shell 命令用）
//   - 字面标量 `|` / `|-`（多行文本用）
//   - 块内的 `#` 不是注释
//   - 块之后的键不受影响（游标推进正确）
//   - 单行写法不受影响（回归）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigYaml } from '../src/cli/commands/shared.js';

describe('parseConfigYaml — 块标量（folded `>`）', () => {
  it('把多行命令折成一条单行命令', () => {
    const yaml = `
gate:
  - name: configure
    run: >
      cmake -S . -B build -G "Visual Studio 17 2022" -A x64
      -DNIMRTC_BUILD_TESTS=ON
  - name: build
    run: "cmake --build build"
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands.length, 2);
    assert.equal(
      result.gate.commands[0].run,
      'cmake -S . -B build -G "Visual Studio 17 2022" -A x64 -DNIMRTC_BUILD_TESTS=ON',
    );
    assert.equal(result.gate.commands[1].run, 'cmake --build build');
  });

  it('折叠后不含换行，命令可直接交给 shell', () => {
    const yaml = `
gate:
  - name: configure
    run: >
      line one
      line two
      line three
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands[0].run, 'line one line two line three');
    assert.ok(!result.gate.commands[0].run.includes('\n'));
  });

  it('`>-` 与 `>` 结果一致（strip 掉末尾换行）', () => {
    const yaml = `
gate:
  - name: a
    run: >-
      alpha
      beta
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands[0].run, 'alpha beta');
  });

  it('块内的 `#` 是内容，不是注释', () => {
    const yaml = `
gate:
  - name: a
    run: >
      echo "# not a comment"
      echo done
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands[0].run, 'echo "# not a comment" echo done');
  });

  it('块之后的同层键照常解析', () => {
    const yaml = `
gate:
  - name: a
    run: >
      one
      two
    timeoutSec: 45
  - name: b
    run: "three"
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands.length, 2);
    assert.equal(result.gate.commands[0].run, 'one two');
    assert.equal(result.gate.commands[0].timeoutSec, 45);
    assert.equal(result.gate.commands[1].run, 'three');
  });
});

describe('parseConfigYaml — 块标量（literal `|`）', () => {
  it('保留换行', () => {
    const yaml = `
gate:
  - name: a
    run: |
      first
      second
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands[0].run, 'first\nsecond');
  });

  it('`|-` 去掉末尾换行', () => {
    const yaml = `
gate:
  - name: a
    run: |-
      first
      second
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands[0].run, 'first\nsecond');
  });
});

describe('parseConfigYaml — 其它段落的块标量', () => {
  it('acceptance.command 支持块标量', () => {
    const yaml = `
gate:
  - { name: test, run: "pnpm test" }
  acceptance:
    command: >
      npm run build
      npm test
    required: true
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.ok(result.gate.acceptance !== undefined);
    assert.equal(result.gate.acceptance!.command, 'npm run build npm test');
  });

  it('agent.command 支持块标量', () => {
    const yaml = `
gate:
  - { name: test, run: "pnpm test" }
agent:
  command: >
    npx
    claude-code
  adapter: "claude-agent-sdk"
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.agent.command, 'npx claude-code');
    assert.equal(result.agent.adapter, 'claude-agent-sdk');
  });

  it('targetProject.gate 的 run 支持块标量', () => {
    const yaml = `
gate:
  - { name: test, run: "pnpm test" }
targetProject:
  path: "../nimrtc-zelto"
  gate:
    - name: configure
      run: >
        cmake -S . -B build
        -DNIMRTC_BUILD_TESTS=ON
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.ok(result.targetProject !== undefined);
    assert.ok(result.targetProject!.gate !== undefined);
    assert.equal(
      result.targetProject!.gate!.commands[0].run,
      'cmake -S . -B build -DNIMRTC_BUILD_TESTS=ON',
    );
  });
});

describe('parseConfigYaml — 单行写法回归', () => {
  it('`run: "..."` 仍照常剥引号', () => {
    const yaml = `
gate:
  - name: test
    run: "pnpm test"
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands[0].run, 'pnpm test');
  });

  it('不以 `>` `|` 开头的值不会被误当成块标量', () => {
    const yaml = `
gate:
  - name: test
    run: "a > b"
  - name: lint
    run: "echo hi"
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands[0].run, 'a > b');
    assert.equal(result.gate.commands[1].run, 'echo hi');
  });
});
