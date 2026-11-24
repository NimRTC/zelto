// `zelto design <req-id>` 的真实仓库上下文注入
//
// 实战缺陷（nimrtc v1.4 演练，2026-11-20）：
//
//   `zelto design` 只把需求文本喂给模型，模型不认识仓库 —— 于是编出了
//   `src/net/`、`src/device/`、`src/events/` 这些不存在的目录，底层库也编错了
//   （写 libnice，实际是 libjuice；写 OpenSSL，实际是 vendored wolfSSL）。
//
// 设计的 `modules[].filePatterns` 是切片写集的来源，路径编错 = 切片要求写不存在的文件，
// 这会一路传到 `arch check` 与合并审计。所以设计生成必须看见真实目录。
//
// 这里覆盖三件事：
//   1. 摘要的**确定性**：只读 ProjectMap，每个模块 ≤ N 条代表性文件，总量有上限
//   2. 摘要**必须**出现在 prompt 里，且带「以扫描结果为准」的约束
//   3. 没有扫描结果时退回旧行为（明确的「没有提供」占位），不是空字符串
//
// C3：纯计算（读文件由 scanner 做），不调模型、不触网。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeProjectStructure, renderStructureSection, extractVendorLibraries } from '../src/llm/project-context.js';
import type { ProjectMap, ProjectModule } from '../src/core/project/types.js';

function mod(name: string, files: string[], testFiles: string[] = [], submodules: ProjectModule[] = []): ProjectModule {
  return { name, files, testFiles, entryPoint: null, submodules };
}

function map(modules: ProjectModule[]): ProjectMap {
  return {
    projectName: 'nimrtc',
    projectType: 'cpp',
    rootDir: '/tmp/nimrtc',
    detectedAt: '2026-11-20T00:00:00.000Z',
    modules,
    configFiles: ['CMakeLists.txt'],
    buildTool: 'cmake',
    testCommand: 'ctest',
    lintCommand: null,
    ignorePatterns: [],
  };
}

describe('项目结构摘要（design 的真实仓库上下文）', () => {
  it('摘要包含真实模块名与代表性文件，不含编造目录', () => {
    const m = map([
      mod('src', [], [], [
        mod('src/modules', [], [], [
          mod('src/modules/ice', ['src/modules/ice/src/ice.cpp', 'src/modules/ice/include/ice.hpp']),
          mod('src/modules/sdp', ['src/modules/sdp/src/sdp.cpp']),
        ]),
        mod('src/engine', ['src/engine/src/engine.cpp']),
      ]),
    ]);
    const s = summarizeProjectStructure(m);
    assert.match(s.modulesMarkdown, /src\/modules\/ice/);
    assert.match(s.modulesMarkdown, /src\/engine/);
    assert.match(s.modulesMarkdown, /src\/modules\/ice\/src\/ice\.cpp/);
    assert.match(s.sourceNote, /确定性扫描结果/);
  });

  it('每个模块的文件列表有上限，超出部分被截短（防止上下文爆掉）', () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/big/f${i}.cpp`);
    const m = map([mod('src/big', files)]);
    const s = summarizeProjectStructure(m);
    assert.match(s.modulesMarkdown, /…\(\+24\)/, '应标出被省略的数量');
    const mentioned = s.modulesMarkdown.match(/src\/big\/f\d+\.cpp/g) ?? [];
    assert.ok(mentioned.length <= 6, `只列前 6 个，实际 ${mentioned.length}`);
  });

  it('顶层模块数量有上限', () => {
    const modules = Array.from({ length: 60 }, (_, i) => mod(`src/m${i}`, [`src/m${i}/a.cpp`]));
    const s = summarizeProjectStructure(map(modules));
    const lines = s.modulesMarkdown.split('\n').filter((l) => /^- `/.test(l));
    assert.equal(lines.length, 40, `只列前 40 个，实际 ${lines.length}`);
    assert.doesNotMatch(s.modulesMarkdown, /src\/m40/, '超出上限的模块不应展开');
  });

  it('字符预算：vendored 大目录不让摘要爆掉（≤ 预算 + 说明行）', () => {
    // 复刻 nimrtc 的 `src/third_party`：一个顶层模块 + 十几万文件
    const big = mod('src/third_party', Array.from({ length: 14256 }, (_, i) => `src/third_party/x/f${i}.c`), [], [
      mod('src/third_party/wolfssl', Array.from({ length: 5000 }, (_, i) => `src/third_party/wolfssl/f${i}.c`)),
      mod('src/third_party/libvpx', Array.from({ length: 5000 }, (_, i) => `src/third_party/libvpx/f${i}.c`)),
    ]);
    const s = summarizeProjectStructure(map([big, ...Array.from({ length: 30 }, (_, i) => mod(`src/m${i}`, [`src/m${i}/a.cpp`]))]));
    assert.ok(
      s.modulesMarkdown.length <= 12000 + 400,
      `摘要 ${s.modulesMarkdown.length} 字符，超过预算`,
    );
    // 主干模块（排在前面的）必须在
    assert.match(s.modulesMarkdown, /src\/third_party/);
  });

  it('扫描没发现模块 → 显式说明，不留空', () => {
    const s = summarizeProjectStructure(map([]));
    assert.match(s.modulesMarkdown, /没有发现源码目录/);
  });

  it('渲染出的 prompt 片段带「真源」声明与构建/测试事实', () => {
    const m = map([mod('src/engine', ['src/engine/src/engine.cpp'])]);
    const text = renderStructureSection(summarizeProjectStructure(m));
    assert.match(text, /## 项目现状（扫描事实，以下为真源）/);
    assert.match(text, /构建工具：cmake/);
    assert.match(text, /测试命令：`ctest`/);
  });

  it('纯函数：同一输入产出完全一致', () => {
    const m = map([mod('src/a', ['src/a/1.cpp', 'src/a/2.cpp'])]);
    assert.deepEqual(summarizeProjectStructure(m), summarizeProjectStructure(m));
    assert.equal(summarizeProjectStructure(m).modulesMarkdown, summarizeProjectStructure(m).modulesMarkdown);
  });
});

// ZD-003：项目结构摘要缺 third_party / vendor 库清单。
//
// 病灶（nimrtc v1.4，2026-11-20）：摘要里只有
// `src/third_party/libjuice/src/Makefile` 这样的**文件路径**，模型得自己推
// 「libjuice 是个库」—— 它推错了：写 libnice（实际 libjuice）、
// 写 OpenSSL（实际是 vendored wolfSSL）。
//
// 修法：把 vendor 目录下的**子目录名**单独抽成「第三方库清单」，
// 并在 prompt 里明说「只能用这些名字」。库名是**事实**，不该靠模型猜。
describe('ZD-003 · 第三方库清单', () => {
  /**
   * 复刻 nimrtc 的 vendor 布局。
   *
   * 注意：模块名**本身就是**相对仓库根的完整路径
   * （`src/third_party/libjuice`），不是路径片段 —— 见 `scanProject`
   * 的 `buildModuleTree`。这里照抄真实形状，否则测的是另一种树。
   */
  function nimrtcMap(): ProjectMap {
    return map([
      mod('src', [], [], [
        mod('src/modules', [], [], [
          mod('src/modules/ice', ['src/modules/ice/src/ice.cpp']),
        ]),
        mod('src/third_party', [], [], [
          mod('src/third_party/libjuice', ['src/third_party/libjuice/src/Makefile']),
          mod('src/third_party/wolfssl', ['src/third_party/wolfssl/src/Makefile']),
          mod('src/third_party/opus', ['src/third_party/opus/src/Makefile']),
        ]),
      ]),
    ]);
  }

  it('认出 vendor 目录下的库名', () => {
    const libs = extractVendorLibraries(nimrtcMap());
    assert.ok(libs.includes('libjuice'), `应认出 libjuice，实际 ${JSON.stringify(libs)}`);
    assert.ok(libs.includes('wolfssl'), '应认出 wolfssl');
    assert.ok(libs.includes('opus'), '应认出 opus');
  });

  it('库目录**下面**的子模块是库内部结构，不被当成新库', () => {
    const m = map([
      mod('src', [], [], [
        mod('src/third_party', [], [], [
          mod('src/third_party/libjuice', [], [], [
            mod('src/third_party/libjuice/src', ['src/third_party/libjuice/src/a.c']),
          ]),
        ]),
      ]),
    ]);
    const libs = extractVendorLibraries(m);
    assert.deepEqual(libs, ['libjuice'], `不该把 src 认成库，实际 ${JSON.stringify(libs)}`);
  });

  it('vendor 目录名之后没有下一段 → 认不出库名（不硬凑）', () => {
    const m = map([mod('src', [], [], [mod('src/third_party', ['src/third_party/x.c'])])]);
    assert.deepEqual(extractVendorLibraries(m), []);
  });

  it('普通业务模块不算第三方库', () => {
    const m = map([
      mod('src', [], [], [
        mod('src/modules', [], [], [mod('src/modules/ice', ['src/modules/ice/a.cpp'])]),
        mod('src/engine', ['src/engine/a.cpp']),
      ]),
    ]);
    assert.deepEqual(extractVendorLibraries(m), []);
  });

  it('渲染出的 prompt 有独立的「第三方库」一节，且明说只能用这些名字', () => {
    const text = renderStructureSection(summarizeProjectStructure(nimrtcMap()));
    assert.match(text, /### 项目已依赖的第三方库/);
    assert.match(text, /libjuice/);
    assert.match(text, /wolfssl/);
    // 明说「只能用这里列出来的名字」—— 少了这句，模型仍会凭印象编
    assert.match(text, /只能用这里列出来的名字/);
  });

  it('没有第三方库时**不出现**那一节（不制造噪声）', () => {
    const text = renderStructureSection(summarizeProjectStructure(map([mod('src/a', ['src/a/1.cpp'])])));
    assert.doesNotMatch(text, /### 项目已依赖的第三方库/);
  });

  it('库清单**不占**模块清单的字符预算（它是独立的一节）', () => {
    const big = mod('src/third_party', Array.from({ length: 14256 }, (_, i) => `src/third_party/x/f${i}.c`), [], [
      mod('src/third_party/wolfssl', Array.from({ length: 5000 }, (_, i) => `src/third_party/wolfssl/f${i}.c`)),
    ]);
    const s = summarizeProjectStructure(map([big]));
    assert.ok(
      s.modulesMarkdown.length <= 12000 + 400,
      `模块清单 ${s.modulesMarkdown.length} 字符，超过预算`,
    );
    // 库名照样认得出来（它不在 modulesMarkdown 里）
    assert.deepEqual(s.vendorLibraries, ['wolfssl']);
  });
});

describe('DESIGN_PROMPT 的占位符与约束', () => {
  it('模板带 {{PROJECT_STRUCTURE}} 与 {{REQUIREMENT_SPEC}} 两个占位符', async () => {
    const { DESIGN_PROMPT } = await import('../src/llm/prompts/design.js');
    assert.match(DESIGN_PROMPT, /\{\{PROJECT_STRUCTURE\}\}/);
    assert.match(DESIGN_PROMPT, /\{\{REQUIREMENT_SPEC\}\}/);
  });

  it('模板明确禁止发明「项目现状」里不存在的顶层目录与库', async () => {
    const { DESIGN_PROMPT } = await import('../src/llm/prompts/design.js');
    assert.match(DESIGN_PROMPT, /模块名与目录路径必须落在「项目现状」已有的结构里/);
    assert.match(DESIGN_PROMPT, /不要凭印象编造/);
  });
});
