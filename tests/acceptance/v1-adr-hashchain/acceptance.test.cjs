// v1-adr-hashchain 验收：docs/adr-100-event-hashchain-p0.md 内容断言
//
// 对应 specs/slices/v1-adr-hashchain.md。第 5 条是占位（"需人补齐"），
// 本文件只断言 ADR-100 正文已包含的四块实质内容；
// 人在评审时补齐口径后，断言与规格一起修订（不静默通过）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'dist', 'cli', 'index.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
const REPO = findRepoRoot(ROOT);
const ADR_PATH = path.join(REPO, 'docs', 'adr-100-event-hashchain-p0.md');

function readAdr() {
  assert.ok(fs.existsSync(ADR_PATH), 'docs/adr-100-event-hashchain-p0.md 必须存在');
  return fs.readFileSync(ADR_PATH, 'utf8');
}

test('ADR-100 首部含编号标题状态', () => {
  const text = readAdr();
  const head = text.split('\n').slice(0, 10).join('\n');
  assert.ok(head.includes('ADR-100'), '首部必须含 ADR-100 编号');
  assert.ok(/状态/.test(head), '首部必须含状态行');
  assert.ok(/哈希链|hash/i.test(text), '全文必须围绕哈希链主题');
});

test('链式块结构与哈希算法有明确描述且无"待定"', () => {
  const text = readAdr();
  assert.ok(/prevHash/.test(text), '必须描述 prevHash 链接字段');
  assert.ok(/SHA-256|sha256/i.test(text), '必须明确哈希算法 SHA-256');
  assert.ok(/stream\.ts/i.test(text), '必须写出 stream.ts 扩展对接点');
  assert.ok(!/待定/.test(text), '核心设计不得标记"待定"');
});

test('audit verify 只读约束有独立段落', () => {
  const text = readAdr();
  assert.ok(/audit verify/i.test(text), '必须有 audit verify 只读校验路径描述');
  assert.ok(/只读|不写|不修改|零写/.test(text), '必须明确只读/不修改事件数据');
});

test('写保护 e2e 验证策略有对应章节', () => {
  const text = readAdr();
  assert.ok(/写保护|PreToolUse|事后.*审计|审计/.test(text), '必须引用写保护机制');
  assert.ok(/e2e|guard-deny|验证策略/i.test(text), '必须指向 e2e 验证策略');
});
