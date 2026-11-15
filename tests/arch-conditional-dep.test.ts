// ADR-064：条件编译（`#ifdef`）的依赖边
//
// 问题：C++ 的 `#include` 可能落在条件编译块里。
// 这种依赖是**真的**（开启那个特性时它就在），但换一套构建配置
// 它可能不存在 —— 读者看到一条边时，默认「所有配置下都有」。
//
// 决策（ADR-064 §3）：
//   1. 条件边**仍然是依赖** —— 不隐藏，不当违规
//   2. **标记**出来，报告里给个提示（软偏离）
//   3. **include 守卫不是条件** —— 守卫永远为真
//
// 第 3 条是重点：真实项目里 431 条 include 在守卫内、249 条在真条件内。
// 不区分的话，标记全是噪音。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseImports, findCppConditionalBlocks } from '../src/core/arch/imports.js';
import { scanArchitecture } from '../src/core/arch/scan.js';
import { buildArchitectureReport } from '../src/core/arch/report.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

describe('ADR-064：条件编译的依赖边', () => {
  describe('include 解析：条件标记', () => {
    it('真条件编译里的 include 被标记', () => {
      const source = [
        '#ifdef _WIN32',
        '#include <windows.h>',
        '#include "nimrtc/core/win.hpp"',
        '#endif',
      ].join('\n');
      const refs = parseImports(source, 'cpp');
      const win = refs.find((r) => r.specifier === 'nimrtc/core/win.hpp');
      assert.ok(win);
      assert.equal(win.cppCondition, '_WIN32');
    });

    it('include 守卫里的 include **不**被标记', () => {
      const source = [
        '#ifndef NIMRTC_ENGINE_ENGINE_HPP',
        '#define NIMRTC_ENGINE_ENGINE_HPP',
        '#include <chrono>',
        '#include "nimrtc/core/log.hpp"',
        '#endif',
      ].join('\n');
      const refs = parseImports(source, 'cpp');
      assert.equal(refs.length, 2);
      for (const ref of refs) {
        assert.equal(ref.cppCondition, undefined, `${ref.specifier} 不该被标成条件依赖`);
      }
    });

    it('条件编译块外的 include 不被标记', () => {
      const source = ['#include "nimrtc/core/log.hpp"'].join('\n');
      const refs = parseImports(source, 'cpp');
      assert.equal(refs[0].cppCondition, undefined);
    });

    it('`#if` 的条件表达式原样保留', () => {
      const source = [
        '#if defined(NIMRTC_PLUGINS_AMF_ON) && defined(_WIN32)',
        '#include "nimrtc/core/log.hpp"',
        '#endif',
      ].join('\n');
      const refs = parseImports(source, 'cpp');
      assert.equal(refs[0].cppCondition, 'defined(NIMRTC_PLUGINS_AMF_ON) && defined(_WIN32)');
    });

    it('`#ifdef` 的条件是宏名本身', () => {
      const source = ['#ifdef _WIN32', '#include "a.hpp"', '#endif'].join('\n');
      const refs = parseImports(source, 'cpp');
      assert.equal(refs[0].cppCondition, '_WIN32');
    });

    it('守卫套在真条件里 —— 仍是条件依赖', () => {
      const source = [
        '#if defined(_WIN32)',
        '#ifndef MY_GUARD_HPP',
        '#define MY_GUARD_HPP',
        '#include "nimrtc/core/win.hpp"',
        '#endif',
        '#endif',
      ].join('\n');
      const refs = parseImports(source, 'cpp');
      // 守卫本身不算条件，但外层的 `#if defined(_WIN32)` 算
      assert.equal(refs[0].cppCondition, 'defined(_WIN32)');
    });
  });

  describe('条件块识别', () => {
    it('区分守卫与真条件', () => {
      const source = [
        '#ifndef GUARD_HPP', // 1
        '#define GUARD_HPP', // 2
        '#endif', // 3
        '#ifdef REAL_COND', // 4
        '#endif', // 5
      ].join('\n');
      const blocks = findCppConditionalBlocks(source);
      const guard = blocks.find((b) => b.condition === 'GUARD_HPP');
      const real = blocks.find((b) => b.condition === 'REAL_COND');
      assert.ok(guard);
      assert.ok(real);
      assert.equal(guard.isGuard, true);
      assert.equal(real.isGuard, false);
    });

    it('`#ifndef X` 后面不是 `#define X` 时 —— 不是守卫', () => {
      const source = ['#ifndef NOT_A_GUARD', '#include "a.hpp"', '#endif'].join('\n');
      const blocks = findCppConditionalBlocks(source);
      assert.equal(blocks[0].isGuard, false);
    });
  });

  describe('端到端：扫描 → 报告', () => {
    const TEST_DIR = mkdtempSync(join(tmpdir(), 'zelto-arch-cond-'));

    const MODULES: ModuleSpec[] = [
      { name: 'src/core', description: '核心', filePatterns: ['src/core/**/*'], dependencies: [] },
      {
        name: 'src/app',
        description: '应用',
        filePatterns: ['src/app/**/*'],
        dependencies: ['src/core'],
      },
    ];

    function write(rel: string, content: string): void {
      const full = join(TEST_DIR, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    }

    before(() => {
      write('src/core/include/nimrtc/core/log.hpp', '#pragma once\nnamespace nimrtc::core {}\n');
      write('src/core/include/nimrtc/core/feature.hpp', '#pragma once\nnamespace nimrtc::core {}\n');

      // src/app 无条件依赖 core
      write('src/app/src/app.cpp', '#include "nimrtc/core/log.hpp"\nint main() { return 0; }\n');
      // src/app 条件依赖 core 的另一个头文件
      write(
        'src/app/src/feature.cpp',
        [
          '#ifdef NIMRTC_FEATURE_ON',
          '#include "nimrtc/core/feature.hpp"',
          '#endif',
          'int feature() { return 1; }\n',
        ].join('\n'),
      );
    });

    after(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('混合边的 conditionalOnly 为 false，且记下条件', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const edge = scan.edges.find((e) => e.from === 'src/app' && e.to === 'src/core');
      assert.ok(edge, 'src/app → src/core 这条边应该在');
      assert.equal(edge.conditionalOnly, false, '有无条件来源，不该是纯条件边');
      assert.ok((edge.conditionalSources ?? 0) > 0);
      assert.ok((edge.unconditionalSources ?? 0) > 0);
      assert.ok(edge.conditions?.includes('NIMRTC_FEATURE_ON'));
    });

    it('报告里出现「条件依赖」软偏离', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      const cond = report.deviations.find((d) => d.kind === 'conditional_dependency');
      assert.ok(cond, '报告里应该有条件依赖提示');
      assert.equal(cond.from, 'src/app');
      assert.equal(cond.to, 'src/core');
      assert.ok(cond.detail.includes('NIMRTC_FEATURE_ON'));
    });

    it('条件依赖是**软**偏离 —— 不影响 ok 结论', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      // 两个模块都声明了依赖，所以除了条件提示没有别的偏离
      const hard = report.deviations.filter(
        (d) => d.kind !== 'unverifiable_dependency' && d.kind !== 'empty_module' && d.kind !== 'conditional_dependency',
      );
      assert.equal(hard.length, 0, `不该有硬偏离：${hard.map((d) => d.kind).join(', ')}`);
      assert.equal(report.ok, true);
    });
  });

  describe('端到端：纯条件边', () => {
    const TEST_DIR = mkdtempSync(join(tmpdir(), 'zelto-arch-cond2-'));

    const MODULES: ModuleSpec[] = [
      { name: 'src/core', description: '核心', filePatterns: ['src/core/**/*'], dependencies: [] },
      {
        name: 'src/app',
        description: '应用',
        filePatterns: ['src/app/**/*'],
        dependencies: ['src/core'],
      },
    ];

    function write(rel: string, content: string): void {
      const full = join(TEST_DIR, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    }

    before(() => {
      write('src/core/include/nimrtc/core/feature.hpp', '#pragma once\nnamespace nimrtc::core {}\n');
      // src/app **只有**条件依赖 core
      write(
        'src/app/src/app.cpp',
        [
          '#ifdef NIMRTC_FEATURE_ON',
          '#include "nimrtc/core/feature.hpp"',
          '#endif',
          'int main() { return 0; }\n',
        ].join('\n'),
      );
    });

    after(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('纯条件边 conditionalOnly 为 true', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const edge = scan.edges.find((e) => e.from === 'src/app' && e.to === 'src/core');
      assert.ok(edge);
      assert.equal(edge.conditionalOnly, true);
      assert.equal(edge.unconditionalSources ?? 0, 0);
    });

    it('纯条件边的报告说清「关闭特性时这条边不存在」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      const cond = report.deviations.find((d) => d.kind === 'conditional_dependency');
      assert.ok(cond);
      assert.ok(cond.detail.includes('只在条件编译下存在'));
      assert.ok(cond.detail.includes('NIMRTC_FEATURE_ON'));
    });
  });
});
