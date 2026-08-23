import { readFileSync } from 'fs';
import { join } from 'path';

export const chatAgentCommonPrompt = readPromptMarkdown('common-chat-agent.md');
export const conversationSummaryFullPrompt = readPromptMarkdown(
  'conversation-summary-full.md',
);
export const conversationSummaryIncrementalPrompt = readPromptMarkdown(
  'conversation-summary-incremental.md',
);
export const conversationTitlePrompt = readPromptMarkdown(
  'conversation-title.md',
);
export const groupRouterPrompt = readPromptMarkdown('group-router.md');
export const groupContextPrompt = readPromptMarkdown('group-context.md');
export const strategyRouterPrompt = readPromptMarkdown('strategy-router.md');
/**
 * 计划审批门禁提示词
 * @description 只用于判断「这份计划要不要请人过目」，不承担任何权限判定——工具审批完全由
 * CapabilityRegistry 推导，Flow 配置没有降低工具风险等级的入口。
 */
export const planReviewGatePrompt = readPromptMarkdown('plan-review-gate.md');
const taskPlannerPromptTemplate = readPromptMarkdown('task-planner.md');

/**
 * 任务规划提示词
 * @param maxSteps 本次允许的最大步骤数
 * @returns 返回填充步数上限后的提示词
 * @description 模板含 {{maxSteps}} 占位符：步数上限由调用方按 agent 配置动态收敛，
 * 不能写死在 markdown 里。
 */
export function buildTaskPlannerPrompt(maxSteps: number): string {
  return taskPlannerPromptTemplate.replace('{{maxSteps}}', String(maxSteps));
}

function readPromptMarkdown(filename: string) {
  // 覆盖两种运行形态：
  // - ts-node/dev：__dirname = <api>/src/prompts
  // - 编译产物：  __dirname = <api>/dist/src/prompts
  // 不依赖构建时的 asset 拷贝，始终能回退到真实的 src/prompts。
  const candidateDirs = [
    __dirname, // .md 与编译产物同目录（nest 拷贝 assets 成功时）
    join(__dirname, '..', '..', '..', 'src', 'prompts'), // dist/src/prompts → api/src/prompts
    join(__dirname, '..', '..', 'src', 'prompts'), // dist/prompts → api/src/prompts（保险）
    join(process.cwd(), 'src', 'prompts'), // 从 apps/api 目录启动时
  ];

  for (const baseDir of candidateDirs) {
    try {
      return readFileSync(join(baseDir, filename), 'utf8').trim();
    } catch {
      // Try the next candidate path.
    }
  }

  throw new Error(`Prompt markdown not found: ${filename}`);
}
