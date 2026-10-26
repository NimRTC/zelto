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
    if (options.json) {
      writeOutput(
        { valid: false, errors: [{ path: policyPath, message: `Failed to read: ${err}`, code: 'E_READ' }] },
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
    if (options.json) {
      writeOutput(
        { valid: false, errors: [{ path: 'policy', message: `Failed to load: ${err}`, code: 'E_LOAD' }] },
        undefined,
        { json: true },
      );
    } else {
      console.log(`${colors.red('✗')} ${colors.bold('Validation: FAILED')}`);
      console.log(`  ${colors.dim(`Failed to load policy: ${err}`)}`);
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
      },
      undefined,
      { json: true },
    );
  } else {
    console.log(`${colors.green('✓')} ${colors.bold('Validation: PASSED')}`);
    console.log(`  ${colors.dim(`Rules: ${config.rules.length}, Protected paths: ${config.protected.length}`)}`);
    console.log(`  ${colors.dim(`Source: ${policyPath}`)}`);
  }

  return 0;
}
