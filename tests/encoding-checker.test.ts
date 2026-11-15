// 编码守卫（scripts/check-encoding.mjs）自身的回归测试。
//
// 为什么需要测它：编码守卫是**最后一道防线** ——
// 其它工具坏了它还能拦住，而它自己坏了就是没人拦。
//
// 实战踩到的坑（D-12）：
// `欢`（U+6B22）被放进了 GBK 误解码特征字表。
// 它**确实**是误解码产物（`喜欢` → `鍠滄箰`），但它**本身是常用汉字** ——
// 一句完全正常的中文测试语料「用户会喜欢这个体验」就能触发它，
// 于是编码守卫对着一个干净文件报错。
//
// 误伤一个检测器比漏一个污染更糟：
// 检测器一旦开始报假警，人就会开始无视它 —— 那它对真污染也失效了。
//
// 注意：本文件**不能**直接写特征字本身 ——
// 那会让编码守卫把本文件判成污染。用转义序列表达。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHECKER = join(process.cwd(), 'scripts', 'check-encoding.mjs');

/** 从守卫源码里解析出特征字集合 */
function loadMarkers(): Set<string> {
  const source = readFileSync(CHECKER, 'utf-8');
  const block = source.match(/MOJIBAKE_MARKERS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, '守卫源码里找不到 MOJIBAKE_MARKERS');
  const markers = new Set<string>();
  for (const match of block[1].matchAll(/\\u([0-9a-fA-F]{4})/g)) {
    markers.add(String.fromCharCode(parseInt(match[1], 16)));
  }
  return markers;
}

/**
 * 常用汉字清单 —— 出现在正常中文里的高频字。
 *
 * 这些字进了特征字表，守卫就会对着干净文件报假警。
 */
const COMMON_HANZI: string[] = [
  // 语法高频
  '的', '一', '是', '不', '了', '在', '人', '我', '他', '这', '个', '上', '下',
  '来', '去', '说', '时', '会', '有', '对', '应', '用', '可', '为', '之', '者',
  '定', '中', '大', '小', '多', '然', '而', '或', '此', '如', '所', '事', '当',
  '后', '前', '里', '外', '内', '新', '旧', '高', '低', '长', '短', '行', '列',
  '名', '字', '符', '串', '本', '文', '件', '路', '径', '数', '据', '库', '表',
  '页', '面', '图', '形', '式', '法', '规', '则', '判', '断', '错', '误', '异',
  '常', '安', '全', '必', '须', '该', '能', '要', '请', '求', '检', '查', '找',
  '到', '见', '知', '道', '明', '确', '认', '准', '否', '需', '想', '做', '好',
  '坏', '少', '非', '空', '间', '序', '顺', '逆', '增', '减', '加', '乘', '除',
  '取', '设', '置', '值', '变', '量', '类', '型', '模', '互', '相', '同', '唯',
  '独', '致', '换', '替', '继', '承', '扩', '展', '属', '性', '版', '次', '第',
  '二', '三', '四', '五', '六', '七', '八', '九', '十', '零', '百', '千', '万',
  // 高频双字词里的实义字（守卫实战误伤过的那类）
  '欢', // 喜欢 / 欢迎 / 欢乐
  '迎', // 欢迎
  '乐', // 欢乐 / 音乐
  '喜', // 喜欢
  '欢', // 喜欢
];

describe('编码守卫：特征字表', () => {
  it('特征字表非空', () => {
    assert.ok(loadMarkers().size >= 20, '特征字表不该是空的');
  });

  it('特征字里没有常用汉字（否则会误伤正常文本）', () => {
    const markers = loadMarkers();
    const hits = COMMON_HANZI.filter((ch) => markers.has(ch));
    assert.deepEqual(
      hits,
      [],
      `特征字表里混进了常用字：${hits.join(' ')} —— 守卫会对干净文件报假警`,
    );
  });

  it('特征字表包含典型的误解码产物（守卫仍然有效）', () => {
    const markers = loadMarkers();
    // 这些是 GBK 误解码的典型产物 —— 去掉它们守卫就瞎了
    for (const cp of [0x951b, 0x9286, 0x9239, 0x9352, 0x93c2, 0x9428, 0x6769, 0x7487]) {
      const ch = String.fromCharCode(cp);
      assert.ok(markers.has(ch), `误解码特征字 U+${cp.toString(16)} 不该被移除`);
    }
  });

  it('误解码文本确实会被检出（端到端验证）', () => {
    const markers = loadMarkers();
    // 一段干净中文按 GBK 误解码后的典型片段。
    // 用码点表达 —— 直接写这些字会让守卫把本文件判成污染。
    const mojibakeSample = String.fromCodePoint(
      0x6769, 0x6b62, 0x4e2a, 0x9354, 0x80fd, 0x6177, 0x6444, 0x8f74, 0x73af, 0x58f0,
    );
    const detected = [...mojibakeSample].some((ch) => markers.has(ch));
    assert.ok(detected, '误解码文本应命中至少一个特征字');
  });

  it('干净的正常中文不会命中', () => {
    const markers = loadMarkers();
    const cleanSamples = [
      '这个功能应该很快，用户会觉得这个体验不错。',
      '合并完成后，签名状态会变成 approved。',
      '架构扫描报告语言覆盖面与实际依赖边。',
      '签字与合并必须分开执行，这是 ADR-018 的要求。',
      'The quick brown fox jumps over the lazy dog.',
      'const x = 1; // 一个变量',
      '用户会喜欢这个体验。', // 曾触发假警的那句
    ];
    for (const sample of cleanSamples) {
      const hits = [...sample].filter((ch) => markers.has(ch));
      assert.deepEqual(hits, [], `干净文本误命中：${hits.join(' ')}`);
    }
  });
});
