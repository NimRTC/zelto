// LLM Command Router — translates natural language into zelto command sequences
// and executes them step by step, showing output in real time.

import type { LlmAdapter } from '../adapters/llm/types.js';
import { COMMAND_ROUTER_PROMPT } from '../llm/prompts/command-router.js';

interface RouterStep {
  command: string;
  args: string[];
}

interface RouterPlan {
  steps: RouterStep[];
  explanation: string;
}

type CommandHandler = (args: string[]) => Promise<number>;

/**
 * Translate user intent into a command plan using LLM.
 */
async function translateIntent(
  llm: LlmAdapter,
  userInput: string,
): Promise<RouterPlan> {
  const prompt = `${COMMAND_ROUTER_PROMPT}\n\n用户输入：${userInput}`;

  const response = await llm.chat({
    messages: [
      {
        role: 'system',
        content: '你是一个 zelto 命令路由助手。只输出 JSON，不要包含其他内容。',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    maxTokens: 2048,
  });

  // Parse JSON from response
  let jsonStr = response.content.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr) as RouterPlan;
  } catch {
    return {
      steps: [],
      explanation: `无法解析 LLM 响应：${response.content.slice(0, 200)}`,
    };
  }
}

/**
 * Execute a single command step by calling its handler.
 * Captures stdout output to extract IDs.
 */
async function executeStep(
  step: RouterStep,
  handlers: Record<string, CommandHandler>,
  idMap: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
  // Resolve compound commands: "project status" → command="project", extraArgs=["status"]
  const cmdParts = step.command.split(/\s+/);
  const cmdKey = cmdParts[0];
  const extraArgs = cmdParts.slice(1);

  const handler = handlers[cmdKey];
  if (!handler) {
    return {
      exitCode: 1,
      output: `未知命令: ${cmdKey}`,
    };
  }

  // Resolve ID placeholders and combine with extra args from compound commands
  const resolvedArgs = [...extraArgs, ...step.args].map((arg) => {
    let resolved = arg;
    for (const [key, value] of Object.entries(idMap)) {
      resolved = resolved.replace(`{${key}}`, value);
    }
    return resolved;
  });

  // Capture console output
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    const msg = args.map(String).join(' ');
    logs.push(msg);
    origLog.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(' ');
    logs.push(msg);
    origError.apply(console, args);
  };

  try {
    const exitCode = await handler(resolvedArgs);
    return { exitCode, output: logs.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

/**
 * Extract IDs from command output using known patterns.
 */
function extractIds(output: string, idMap: Record<string, string>): Record<string, string> {
  const newMap = { ...idMap };

  const patterns: Array<{ key: string; regex: RegExp }> = [
    { key: 'reqId', regex: /✅ Requirement created:\s*(\S+)/ },
    { key: 'dsgId', regex: /✅ Design created:\s*(\S+)/ },
    { key: 'planId', regex: /✅ Plan created:\s*(\S+)/ },
    { key: 'reqId', regex: /✅ Requirement "(\S+)" confirmed/ },
    { key: 'dsgId', regex: /Design "(\S+)" confirmed/ },
    { key: 'planId', regex: /Plan "(\S+)" confirmed/ },
  ];

  for (const { key, regex } of patterns) {
    const match = output.match(regex);
    if (match && !newMap[key]) {
      newMap[key] = match[1];
    }
  }

  return newMap;
}

/**
 * Main entry: translate user intent and execute the plan.
 */
export async function routeAndExecute(
  userInput: string,
  llm: LlmAdapter,
  handlers: Record<string, CommandHandler>,
): Promise<number> {
  console.log(`\n🤔 正在理解你的意图...`);

  const plan = await translateIntent(llm, userInput);

  if (plan.steps.length === 0) {
    console.log(`\n❌ ${plan.explanation}`);
    return 1;
  }

  console.log(`\n📋 执行计划：${plan.explanation}`);
  console.log('');

  let idMap: Record<string, string> = {};
  let stepIndex = 0;

  for (const step of plan.steps) {
    stepIndex++;
    const argsDisplay = step.args.map((a) =>
      a.length > 60 ? a.slice(0, 60) + '...' : a,
    ).join(' ');

    console.log(`\n── Step ${stepIndex}: zelto ${step.command} ${argsDisplay} ──`);

    const { exitCode, output } = await executeStep(step, handlers, idMap);

    // Extract IDs from output
    idMap = extractIds(output, idMap);

    if (exitCode !== 0) {
      console.error(`\n❌ Step ${stepIndex} 失败 (exit ${exitCode})`);
      console.error(`   后续步骤已取消。`);
      return exitCode;
    }

    console.log(`   ✅ Step ${stepIndex} 完成`);
  }

  console.log(`\n✅ 全部 ${stepIndex} 个步骤执行完毕！`);
  return 0;
}
