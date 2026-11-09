/**
 * validate.command.ts — `zelto policy validate` subcommand
 *
 * Validates the policy.yaml configuration for correctness.
 * Uses the deterministic core validator (src/core/policy/validator.ts).
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { existsSync, readFileSync } from 'node:fs';
import { loadPolicyConfig } from '../../commands/shared.js';
import { validatePolicyConfig, validatePolicyYaml } from '../../../core/policy/validator.js';
import { checkPolicyAnchor } from '../../../core/policy/lock.js';
import { colors } from '../../color.js';
import { writeOutput } from '../../output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Validate command
// ---------------------------------------------------------------------------

export async function validatePolicy(options: ValidateOptions): Promise<number> {
  const policyPath = 'policy/policy.yaml';

  // Check if policy file exists
  if (!existsSync(policyPath)) {
    if (options.json) {
      writeOutput(
        { valid: false, errors: [{ path: policyPath, message: 'Policy file not found', code: 'E_NOT_FOUND' }] },
        undefined,
        { json: true },
      );
    } else {
      console.log(`${colors.red('✗')} ${colors.bold('Validation: FAILED')}`);
      console.log(`  ${colors.dim(`Policy file not found: ${policyPath}`)}`);
    }
    return 1;
  }

  // Read raw YAML content
  let yamlContent: string;
  try {
    yamlContent = readFileSync(policyPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (options.json) {
      writeOutput(
        { valid: false, errors: [{ path: policyPath, message: `Failed to read: ${msg}`, code: 'E_READ' }] },
        undefined,
        { json: true },
      );
    } else {
      console.log(`${colors.red('✗')} ${colors.bold('Validation: FAILED')}`);
      console.log(`  ${colors.dim(`Failed to read: ${policyPath}`)}`);
    }
    return 1;
  }

  // Validate raw YAML structure
  const yamlResult = validatePolicyYaml(yamlContent);

  if (!yamlResult.valid) {
    if (options.json) {
      writeOutput(
        {
          valid: false,
          errors: yamlResult.errors.map((e) => ({
            path: e.path,
            message: e.message,
            code: e.code,
          })),
        },
        undefined,
        { json: true },
      );
    } else {
      console.log(`${colors.red('✗')} ${colors.bold('Validation: FAILED')}`);
      for (const err of yamlResult.errors) {
        const code = err.code ? ` [${colors.yellow(err.code)}]` : '';
        console.log(`  ${colors.red('✗')} ${err.path ? `${colors.dim(err.path)}: ` : ''}${err.message}${code}`);
      }
    }
    return 1;
  }

  // Load and validate parsed config
  let config;
  try {
    config = loadPolicyConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (options.json) {
      writeOutput(
        { valid: false, errors: [{ path: 'policy', message: `Failed to load: ${msg}`, code: 'E_LOAD' }] },
        undefined,
        { json: true },
      );
    } else {
      console.log(`${colors.red('✗')} ${colors.bold('Validation: FAILED')}`);
      console.log(`  ${colors.dim(`Failed to load policy: ${msg}`)}`);
    }
    return 1;
  }

  // Validate parsed config
  const configResult = validatePolicyConfig(config);

  if (!configResult.valid) {
    if (options.json) {
      writeOutput(
        {
          valid: false,
          errors: configResult.errors.map((e) => ({
            path: e.path,
            message: e.message,
            code: e.code,
          })),
        },
        undefined,
        { json: true },
      );
    } else {
      console.log(`${colors.red('✗')} ${colors.bold('Validation: FAILED')}`);
      for (const err of configResult.errors) {
        const code = err.code ? ` [${colors.yellow(err.code)}]` : '';
        console.log(`  ${colors.red('✗')} ${err.path ? `${colors.dim(err.path)}: ` : ''}${err.message}${code}`);
      }
    }
    return 1;
  }

  // 策略锚点（C5）
  //
  // 锚点独立存放在 policy/lock.json。策略文件自己声明自己的哈希是自证 ——
  // 改策略的人顺手把哈希也改掉，事后就看不出「当时按什么标准拦的」被换过。
  // 锚点独立之后，「策略被改过而没人改锚」就是一件可检出的事。
  //
  // **这里只警告，不失败。** 职责边界：`validate` 判的是「策略文件本身是否合法」，
  // 退出码只反映这一件事；锚点失配由 `zelto policy lock` 判（退出码 1，可当门禁）。
  //
  // 为什么要分开：接管既有项目时，人换掉自己的策略是常态（zelto 生成的策略
  // 未必是这个人想要的）。若 validate 因失配就红，人每次换策略都得先改锚 ——
  // 「失配 = 可检出的改动」就退化成「每次改策略先走一遍仪式」，人只会绕过它。
  // 判与报分开：validate 照样把失配说出来（不藏），lock 才是那个当门禁用的判据。
  const anchor = checkPolicyAnchor(process.cwd());
  const anchorWarning = anchor.mismatch
    ? `策略锚点失配：锚点记的是 ${anchor.locked}，当前 policy.yaml 是 ${anchor.current}。` +
      `策略被改过而锚点没动 —— 确认改动是有意的，跑 zelto policy lock --update 改锚。`
    : null;

  // All valid
  if (options.json) {
    writeOutput(
      {
        valid: true,
        errors: [],
        summary: {
          rules: config.rules.length,
          protected: config.protected.length,
        },
        // 锚点状态随输出一起给：不藏，但也不改变 valid（valid 只说策略本身）
        anchor: {
          status: anchor.mismatch ? 'mismatch' : anchor.hasLock ? 'matched' : 'unanchored',
          locked: anchor.locked,
          current: anchor.current,
          mismatch: anchor.mismatch,
          source: anchor.source,
        },
        ...(anchorWarning ? { warnings: [anchorWarning] } : {}),
      },
      undefined,
      { json: true },
    );
  } else {
    console.log(`${colors.green('✓')} ${colors.bold('Validation: PASSED')}`);
    console.log(`  ${colors.dim(`Rules: ${config.rules.length}, Protected paths: ${config.protected.length}`)}`);
    console.log(`  ${colors.dim(`Source: ${policyPath}`)}`);
    if (anchorWarning) {
      console.log('');
      console.log(`${colors.yellow('⚠')} ${colors.bold('锚点失配')} ${colors.dim('（不影响 validate 的退出码 —— 判锚点用 zelto policy lock）')}`);
      console.log(`  ${colors.dim(anchorWarning)}`);
    }
  }

  return 0;
}
