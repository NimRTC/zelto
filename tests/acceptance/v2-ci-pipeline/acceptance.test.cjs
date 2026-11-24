// v2-ci-pipeline 验收：ci.yml 含 windows-latest 作业复用三脚本且用 bash。
// 对应 specs/slices/v2-ci-pipeline.md 四条验收标准。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
const REPO = findRepoRoot(path.resolve(__dirname, '..', '..', '..'));
const CI_PATH = path.join(REPO, '.github', 'workflows', 'ci.yml');

function ci() {
  assert.ok(fs.existsSync(CI_PATH), '.github/workflows/ci.yml 必须存在');
  return fs.readFileSync(CI_PATH, 'utf-8');
}

test('新增 windows-latest 作业且复用三脚本', () => {
  const text = ci();
  assert.ok(text.includes('windows-latest'), '必须有 windows-latest 作业');
  assert.ok(text.includes('pnpm build'), '必须复用 build');
  assert.ok(text.includes('pnpm test:quick'), '必须复用 test:quick');
  assert.ok(text.includes('pnpm lint'), '必须复用 lint');
});

test('新作业显式使用 bash', () => {
  const text = ci();
  assert.ok(text.includes('shell: bash'), 'windows 作业必须显式 shell: bash');
});

test('原 ubuntu 作业保持不变', () => {
  const text = ci();
  assert.ok(text.includes('ubuntu-latest'), '原 ubuntu 作业必须保留');
});

test('ci.yml 可解析且含两个作业', () => {
  const text = ci();
  assert.ok(text.includes('build-and-test'), '必须保留原作业名');
  assert.ok(text.includes('build-and-test-windows'), '必须新增 windows 作业名');
});
