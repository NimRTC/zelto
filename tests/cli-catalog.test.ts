// 命令目录与命令注册表必须一一对应 —— 防止 help 再次漏命令
//
// 这条不变式是被真实事故逼出来的：
//   - 13 个已注册的命令没进 `zelto help`（artifact / dashboard / depgraph /
//     drift / merge / reservation / set / slice-status / spec-md / ss /
//     task-status / tasks / wait）
//   - `zelto help run` 直接崩——以前 help 走 handler(['--help'])，
//     而多数命令不认 --help，于是把 "--help" 当切片 id 去找，ENOENT。
//   - shell 补全的命令列表又少了十几个。
//
// 根因是同一个：命令清单写了三份。现在三份都从 catalog.ts 出，
// 这个测试守住「注册了的必须在目录里，目录里的必须真的注册了」。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_CATALOG, COMMAND_GROUPS, commandsByGroup, findCommand, usageOf } from '../src/cli/commands/catalog.js';
// 副作用导入：把所有命令文件注册进 commands 表
import '../src/cli/commands/index.js';
import { commands } from '../src/cli/commands/shared.js';

describe('命令目录', () => {
  it('每个注册了的命令都在目录里', () => {
    const registered = Object.keys(commands).sort();
    const cataloged = COMMAND_CATALOG.map((c) => c.name).sort();
    const missing = registered.filter((n) => !cataloged.includes(n));
    assert.deepEqual(missing, [], `这些命令注册了但没进命令目录，zelto help 会漏掉它们：${missing.join(', ')}`);
  });

  it('目录里的每个命令都真的注册了', () => {
    const registered = Object.keys(commands);
    const orphans = COMMAND_CATALOG.map((c) => c.name).filter((n) => !registered.includes(n));
    assert.deepEqual(orphans, [], `这些命令在目录里但没实现：${orphans.join(', ')}`);
  });

  it('命令名不重复', () => {
    const names = COMMAND_CATALOG.map((c) => c.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dupes, [], `命令目录里有重名：${dupes.join(', ')}`);
  });

  it('每个命令的分组都在分组表里', () => {
    const unknown = COMMAND_CATALOG.map((c) => c.group).filter((g) => !COMMAND_GROUPS.includes(g));
    assert.deepEqual(unknown, [], `未登记的分组：${unknown.join(', ')}`);
  });

  it('每个命令都有名字与说明', () => {
    for (const c of COMMAND_CATALOG) {
      assert.ok(c.name.trim().length > 0, '命令名不能为空');
      assert.ok(c.summary.trim().length > 0, `命令 ${c.name} 缺说明`);
    }
  });

  it('用法行由命令名与参数拼成', () => {
    assert.equal(usageOf(findCommand('run')!), 'zelto run <id>');
    assert.equal(usageOf(findCommand('help')!), 'zelto help [<cmd>]');
    assert.equal(usageOf(findCommand('inbox')!), 'zelto inbox');
  });

  it('按分组归拢后命令总数不变', () => {
    const grouped = commandsByGroup();
    const total = grouped.reduce((sum, g) => sum + g.commands.length, 0);
    assert.equal(total, COMMAND_CATALOG.length);
    // 分组顺序按 COMMAND_GROUPS 走
    assert.deepEqual(grouped.map((g) => g.group), COMMAND_GROUPS.filter((g) => COMMAND_CATALOG.some((c) => c.group === g)));
  });
});
