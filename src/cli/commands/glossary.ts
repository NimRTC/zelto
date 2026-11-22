// `zelto glossary` —— 领域词汇表（项目的共享语言）
//
// 做什么：维护一份项目的领域词汇表，并检查规格正文对它的使用。
//
// 为什么需要（见 core/glossary/glossary.ts 的说明）：
//   zelto 的追溯链全是结构化产物，没有一处是**语言**。
//   agent 之间最容易出的岔子不是「没按规格写」，而是「各自造词」——
//   同一个概念两个 agent 各叫一个名字，追溯链查不出来。
//
// 子命令：
//   zelto glossary show              看词表
//   zelto glossary add <term>        加一个术语
//   zelto glossary remove <term>     删一个术语
//   zelto glossary check [slice-id]  检查规格正文对词表的使用
//
// 状态只在文件里（C1）：词表落在 `.zelto/glossary.json` ——
// `.zelto/**` 在保护域里（C5），agent 改不了它，词表是人维护的。

import { getDefaultFormatter } from '../output-formatter.js';
import { colors } from '../color.js';
import { register, events, store, ZELTO_DIR } from './shared.js';
import { GlossaryStore, checkGlossaryUsage } from '../../core/glossary/index.js';

register('glossary', async (args) => {
  const f = getDefaultFormatter();
  const asJson = args.includes('--json');
  const subcmd = args[0] ?? 'show';
  const store_ = new GlossaryStore(ZELTO_DIR);

  if (subcmd === 'show') {
    const glossary = await store_.read();
    if (!glossary) {
      if (asJson) {
        f.data({ hasGlossary: false, terms: [] });
        return 0;
      }
      f.out('尚未建立词汇表。');
      f.out(`   位置：${store_.path}`);
      f.out('   建立：zelto glossary add <term> --meaning "<意思>"');
      return 0;
    }

    if (asJson) {
      f.data({ hasGlossary: true, path: store_.path, glossary });
      return 0;
    }

    f.out(`${colors.bold('领域词汇表')} ${colors.dim(store_.path)}`);
    f.out(`${colors.dim(`版本 ${glossary.version} · 更新于 ${glossary.updatedAt || '未知'} · ${glossary.updatedBy || '未知'}`)}`);
    f.out(`${colors.dim('─'.repeat(56))}`);
    if (glossary.terms.length === 0) {
      f.out(`  ${colors.dim('（空）')}`);
      return 0;
    }
    for (const t of glossary.terms) {
      const controlled = t.controlled ? colors.yellow(' [受控]') : '';
      f.out(`  ${colors.cyan(t.term)}${controlled}`);
      if (t.meaning) f.out(`    ${t.meaning}`);
      if (t.aliases.length > 0) f.out(`    ${colors.dim(`别名: ${t.aliases.join('、')}`)}`);
    }
    return 0;
  }

  if (subcmd === 'add') {
    // 术语取第一个**非旗标**参数 —— `glossary add --json slice` 也要能用。
    const term = args.slice(1).find((a) => !a.startsWith('--'));
    if (!term) {
      f.error('USAGE', 'Usage: zelto glossary add <term> --meaning "<意思>" [--alias <a>]... [--controlled]');
      return 1;
    }

    const meaning = readFlag(args, '--meaning') ?? '';
    const aliases: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--alias' && args[i + 1]) aliases.push(args[i + 1]);
    }
    const controlled = args.includes('--controlled');

    const glossary = await store_.upsert(
      { term, meaning, aliases, controlled },
      'human',
    );

    await events.append('glossary', 'glossary.updated', 'zelto', {
      action: 'add',
      term,
      totalTerms: glossary.terms.length,
    });

    f.success(`词汇表已更新：${term}（共 ${glossary.terms.length} 条）`);
    return 0;
  }

  if (subcmd === 'remove') {
    const term = args.slice(1).find((a) => !a.startsWith('--'));
    if (!term) {
      f.error('USAGE', 'Usage: zelto glossary remove <term>');
      return 1;
    }

    const before = await store_.read();
    const glossary = await store_.remove(term, 'human');
    if (!glossary) {
      f.error('NOT_FOUND', '尚未建立词汇表。');
      return 1;
    }

    const removed = (before?.terms.length ?? 0) > glossary.terms.length;
    await events.append('glossary', 'glossary.updated', 'zelto', {
      action: 'remove',
      term,
      totalTerms: glossary.terms.length,
    });

    if (!removed) {
      f.warn(`词表里没有 "${term}" —— 未做改动。`);
      return 0;
    }
    f.success(`已从词汇表移除：${term}（共 ${glossary.terms.length} 条）`);
    return 0;
  }

  if (subcmd === 'check') {
    const glossary = await store_.read();
    if (!glossary) {
      if (asJson) {
        f.data({ hasGlossary: false, checked: false });
        return 0;
      }
      f.out('尚未建立词汇表 —— 没有可对比的对象，本次不做判断。');
      f.out('   建立：zelto glossary add <term> --meaning "<意思>"');
      return 0;
    }

    // 查哪份规格：给了切片就查切片，否则查全部切片
    //
    // **必须跳过旗标** —— `zelto glossary check --json` 的 `args[1]` 是
    // `--json`，不是切片 id。当成切片 id 去读，会撞上「文件不存在」的
    // 未捕获异常（ENOENT 直接崩，而不是报「切片不存在」）。
    const sliceId = args.slice(1).find((a) => !a.startsWith('--'));
    const targets: Array<{ id: string; text: string }> = [];

    if (sliceId) {
      // 切片不存在 → 明确报错，不抛异常。
      // `store.read` 抛 ENOENT —— 那是**异常**，不是「没找到」。
      // 直接冒泡出去会变成一段 stack trace，而不是一句人话。
      let slice;
      try {
        slice = await store.read(sliceId);
      } catch {
        f.error('NOT_FOUND', `切片 "${sliceId}" 不存在。`);
        return 1;
      }
      const specPath = slice.spec?.path ?? `specs/slices/${sliceId}.md`;
      const { readFileSync, existsSync } = await import('node:fs');
      if (!existsSync(specPath)) {
        f.error('NOT_FOUND', `找不到规格文件：${specPath}`);
        return 1;
      }
      targets.push({ id: sliceId, text: readFileSync(specPath, 'utf-8') });
    } else {
      const { readdirSync, readFileSync, existsSync } = await import('node:fs');
      const dir = 'specs/slices';
      if (!existsSync(dir)) {
        f.out('没有 specs/slices/ 目录 —— 没有可检查的规格。');
        return 0;
      }
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const text = readFileSync(`${dir}/${name}`, 'utf-8');
        targets.push({ id: name.replace(/\.md$/, ''), text });
      }
    }

    const results = targets.map((t) => ({
      sliceId: t.id,
      report: checkGlossaryUsage(t.text, glossary),
    }));

    const totalUnknown = results.reduce((s, r) => s + r.report.unknownTerms.length, 0);
    const totalControlled = results.reduce((s, r) => s + r.report.controlledViolations.length, 0);

    await events.append('glossary', 'glossary.usage_checked', 'zelto', {
      specs: results.length,
      unknownTerms: totalUnknown,
      controlledViolations: totalControlled,
    });

    if (asJson) {
      f.data({
        hasGlossary: true,
        totalTerms: glossary.terms.length,
        specs: results.length,
        unknownTerms: totalUnknown,
        controlledViolations: totalControlled,
        results,
      });
      return 0;
    }

    f.out('');
    f.out(`${colors.bold(colors.cyan('词汇表使用检查'))} ${colors.dim('（字面比对，确定性）')}`);
    f.out(`${colors.dim(`词表 ${glossary.terms.length} 条 · 规格 ${results.length} 份`)}`);
    f.out(`${colors.dim('─'.repeat(56))}`);

    for (const { sliceId: sid, report } of results) {
      if (report.usedTerms.length === 0 && report.unknownTerms.length === 0) continue;
      f.out('');
      f.out(`  ${colors.bold(sid)}`);
      if (report.usedTerms.length > 0) {
        f.out(`    ${colors.green('✔')} 用到的术语：${report.usedTerms.join('、')}`);
      }
      if (report.unknownTerms.length > 0) {
        f.out(`    ${colors.yellow('●')} 词表里没有的候选术语：${report.unknownTerms.join('、')}`);
        f.out(`      ${colors.dim('这些是候选，不是定论 —— 确认后用 zelto glossary add 收进词表')}`);
      }
      for (const v of report.controlledViolations) {
        f.out(`    ${colors.yellow('●')} 受控术语 "${v.canonical}" 用了别名 "${v.used}"`);
      }
    }

    f.out('');
    if (totalUnknown === 0 && totalControlled === 0) {
      f.success('规格里的术语都与词表一致。');
    } else {
      f.warn(
        `检出 ${totalUnknown} 个词表外的候选术语${totalControlled > 0 ? `、${totalControlled} 处受控术语被别名绕过` : ''}。`,
      );
    }
    return 0;
  }

  f.error('USAGE', 'Usage: zelto glossary [show|add|remove|check] ...');
  f.out('       zelto glossary show                    看词表');
  f.out('       zelto glossary add <term>              加一个术语');
  f.out('       zelto glossary remove <term>           删一个术语');
  f.out('       zelto glossary check [slice-id]        检查规格对词表的使用');
  return 1;
});

/** 读 `--flag value` 形式的参数值 */
function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}
