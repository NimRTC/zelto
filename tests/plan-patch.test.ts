// ADR-063 的版本计划层对应物：`zelto plan patch`（计划切片的确定性修正）
//
// 为什么要这个命令（实战演练踩到的）：
//
//   1. 需求文档（`docs/plan/ai-game-demo-plan.md`）的里程碑结构变了
//      —— 切片清单要重排（M1/M2/M3）
//   2. 已确认的计划改不了：`zelto plan add-version` 走 LLM，
//      而且只能加整个版本，改不了某个切片的写集、也加不了单个切片
//   3. 只能手改 `.zelto/versions/<id>.json`
//
// 手改状态文件是**追溯链上的谎言**：文件变了，事件流里没有记录（C4）；
// 而且计划里的 `writes` 与 `.zelto/slices/<id>.json` 里的 `writes`
// 必须一致，手改只改一边 → `version start` 建出来的切片写集是错的。
//
// 所以这个命令的核心断言是：**只改指定的那一处，且改动是可追溯的**。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlanPatch,
  findDuplicateSliceIds,
  normalizeWriteSet,
  type PlanPatch,
} from '../src/core/version/patch.js';
import type { VersionPlan } from '../src/core/version/types.js';

function makePlan(): VersionPlan {
  return {
    id: 'plan-1',
    designId: 'dsg-1',
    title: '测试计划',
    status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
    versions: [
      {
        version: 'v1',
        dependsOn: [],
        description: '第一版',
        integrationTestDir: 'tests/acceptance/v1/',
        status: 'integrated',
        slices: [
          {
            id: 'v1-a',
            module: '模块A',
            title: '切片A',
            writes: ['src/a.cpp'],
            specPath: 'specs/slices/v1-a.md',
            state: 'completed',
          },
        ],
      },
      {
        version: 'v2',
        dependsOn: ['v1'],
        description: '第二版',
        integrationTestDir: 'tests/acceptance/v2/',
        status: 'in_progress',
        slices: [
          {
            id: 'v2-b',
            module: '模块B',
            title: '切片B',
            writes: ['demo-agent-realtime/**'],
            specPath: 'specs/slices/v2-b.md',
            state: 'draft',
          },
        ],
      },
    ],
  };
}

describe('版本计划的确定性修正（zelto plan patch）', () => {
  describe('写集修正', () => {
    it('改写集的路径并留下 before/after', () => {
      const plan = makePlan();
      const patch: PlanPatch = {
        versions: [
          {
            version: 'v2',
            slices: [{ sliceId: 'v2-b', writes: ['examples/demo-agent-realtime/**'] }],
          },
        ],
      };
      const result = applyPlanPatch(plan, patch);
      assert.equal(result.changed.length, 1);
      assert.equal(result.changed[0].field, 'writes');
      assert.equal(result.changed[0].before, 'demo-agent-realtime/**');
      assert.equal(result.changed[0].after, 'examples/demo-agent-realtime/**');
      assert.deepEqual(
        result.plan.versions[1].slices[0].writes,
        ['examples/demo-agent-realtime/**'],
      );
    });

    it('写集统一正斜杠并去重', () => {
      const plan = makePlan();
      const patch: PlanPatch = {
        versions: [
          {
            version: 'v2',
            slices: [
              {
                sliceId: 'v2-b',
                writes: ['src\\a.cpp', 'src/a.cpp', ' src/b.cpp '],
              },
            ],
          },
        ],
      };
      const result = applyPlanPatch(plan, patch);
      assert.deepEqual(result.plan.versions[1].slices[0].writes, ['src/a.cpp', 'src/b.cpp']);
    });

    it('不改入参（原计划对象保持原样）', () => {
      const plan = makePlan();
      const before = JSON.stringify(plan);
      applyPlanPatch(plan, {
        versions: [{ version: 'v2', slices: [{ sliceId: 'v2-b', writes: ['x.cpp'] }] }],
      });
      assert.equal(JSON.stringify(plan), before);
    });
  });

  describe('加切片 / 删切片', () => {
    it('加切片时写集被归一化', () => {
      const plan = makePlan();
      const result = applyPlanPatch(plan, {
        versions: [
          {
            version: 'v2',
            addSlices: [
              {
                id: 'v2-c',
                module: '模块C',
                title: '切片C',
                writes: ['tools\\rd_lan.py'],
                specPath: 'specs/slices/v2-c.md',
                state: 'draft',
              },
            ],
          },
        ],
      });
      assert.equal(result.changed.length, 1);
      assert.equal(result.changed[0].field, 'added');
      const added = result.plan.versions[1].slices.find((s) => s.id === 'v2-c');
      assert.ok(added);
      assert.deepEqual(added.writes, ['tools/rd_lan.py']);
    });

    it('已存在的切片不被重复添加', () => {
      const plan = makePlan();
      const result = applyPlanPatch(plan, {
        versions: [
          {
            version: 'v2',
            addSlices: [
              {
                id: 'v2-b',
                module: 'x',
                title: '重复',
                writes: [],
                specPath: 'p',
              },
            ],
          },
        ],
      });
      assert.equal(result.changed.length, 0);
      assert.equal(result.plan.versions[1].slices.length, 1);
    });

    it('删切片', () => {
      const plan = makePlan();
      const result = applyPlanPatch(plan, {
        versions: [{ version: 'v2', removeSlices: ['v2-b'] }],
      });
      assert.equal(result.changed[0].field, 'removed');
      assert.equal(result.plan.versions[1].slices.length, 0);
    });

    it('删不存在的切片被记为 missing，不静默忽略', () => {
      const plan = makePlan();
      const result = applyPlanPatch(plan, {
        versions: [{ version: 'v2', removeSlices: ['v2-不存在'] }],
      });
      assert.deepEqual(result.missingSlices, ['v2/v2-不存在']);
      assert.equal(result.changed.length, 0);
    });
  });

  describe('版本层面的修正', () => {
    it('改描述与依赖', () => {
      const plan = makePlan();
      const result = applyPlanPatch(plan, {
        versions: [
          {
            version: 'v2',
            description: 'M1 单机闭环',
            dependsOn: ['v1', 'v0'],
          },
        ],
      });
      assert.equal(result.plan.versions[1].description, 'M1 单机闭环');
      assert.deepEqual(result.plan.versions[1].dependsOn, ['v1', 'v0']);
    });

    it('找不到的版本被记为 missing', () => {
      const plan = makePlan();
      const result = applyPlanPatch(plan, {
        versions: [{ version: 'v99', description: 'x' }],
      });
      assert.deepEqual(result.missingVersions, ['v99']);
      assert.equal(result.changed.length, 0);
    });
  });

  describe('重复切片 id 检查', () => {
    it('同一个切片 id 出现在两个版本里会被查出', () => {
      const plan = makePlan();
      plan.versions[1].slices[0].id = 'v1-a';
      const dups = findDuplicateSliceIds(plan);
      assert.deepEqual(dups, ['v1-a']);
    });

    it('正常计划没有重复', () => {
      assert.deepEqual(findDuplicateSliceIds(makePlan()), []);
    });
  });

  describe('normalizeWriteSet', () => {
    it('去空白、统一斜杠、去重、保序', () => {
      assert.deepEqual(
        normalizeWriteSet([' src/a.cpp ', 'src\\b.cpp', 'src/a.cpp', '']),
        ['src/a.cpp', 'src/b.cpp'],
      );
    });
  });
});
