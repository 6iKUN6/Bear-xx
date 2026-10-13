import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../../llm/llm.service';
import type { LlmMessage } from '../../../llm/llm.types';
import { z } from 'zod';
import { buildTaskPlannerPrompt } from '../../../../prompts';
import type { AgentLoopInput } from '../agent-loop.types';
import type { AgentPlan, PlanStep } from './plan.types';
import type { ReasoningSelection } from '@litter-bear/types';

/** 模型规划最多产出的步骤数上限（再受 maxSteps 约束） */
const PLANNER_HARD_STEP_CAP = 5;

/** 计划输出契约：约束模型输出，同时用于校验（含降级路径） */
const planSchema = z.object({
  steps: z.array(
    z.object({
      goal: z.string().min(1).describe('该步骤要达成的目标'),
      suggestedTools: z
        .array(z.string())
        .optional()
        .describe('建议使用的工具名（可选）'),
    }),
  ),
});

type PlanOutput = z.infer<typeof planSchema>;

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  constructor(private readonly llmService: LlmService) {}

  /**
   * 生成任务计划
   * @param input agent loop 输入上下文
   * @param maxSteps 步骤预算上限
   * @param feedback 已累计的重规划意见
   * @param modelPreset Flow 节点编译后锁定的模型预设业务标识
   * @returns 返回结构化任务计划
   * @description 使用 Flow plan 节点指定的预设做一次结构化输出调用，把用户请求拆解为可执行步骤；
   * 任何失败（模型不可用/输出非法/解析为空）都回退为"单步 = 原始请求"的兜底计划，保证主链路不被规划环节拖垮。
   */
  async plan(
    input: AgentLoopInput,
    maxSteps: number,
    feedback: string[] = [],
    modelPreset?: string,
    reasoning?: ReasoningSelection,
    prepared?: {
      messages: LlmMessage[];
      maxOutputTokens: number;
      fallbackUserText: string;
    },
  ): Promise<AgentPlan> {
    const userText =
      prepared?.fallbackUserText ?? this.readLatestUserText(input.messages);
    const cap = Math.max(1, Math.min(maxSteps, PLANNER_HARD_STEP_CAP));

    try {
      const parsed = await this.llmService.generateStructured(
        prepared?.messages ?? buildPlannerMessages(input, maxSteps, feedback),
        planSchema,
        {
          schemaName: 'agent_plan',
          // 不覆盖 temperature：部分模型（如 kimi-for-coding）仅允许 temperature=1，交由预设/模型默认。
          ...(modelPreset
            ? {
                request: {
                  model: { modelId: modelPreset },
                  reasoning,
                  ...(prepared
                    ? {
                        generation: {
                          maxOutputTokens: prepared.maxOutputTokens,
                        },
                      }
                    : {}),
                },
              }
            : {}),
          abortSignal: input.abortSignal,
        },
      );

      const steps = this.toPlanSteps(parsed).slice(0, cap);
      if (steps.length > 0) {
        return { steps, fromModel: true };
      }

      this.logger.warn('Planner 未产出有效步骤，回退单步计划');
    } catch (error) {
      this.logger.warn(
        `Planner 规划失败，回退单步计划：${(error as Error).message}`,
      );
    }

    return {
      steps: [{ id: 'step-1', goal: userText || '完成用户请求' }],
      fromModel: false,
    };
  }

  /**
   * 结构化输出 → 计划步骤
   * @param parsed 已通过 schema 校验的输出（null = 结构化与降级路径均失败）
   * @returns 返回步骤列表；无有效步骤时返回空数组（触发单步兜底）
   * @description schema 已保证形状，这里只做 id 编号与空目标过滤。
   */
  private toPlanSteps(parsed: PlanOutput | null): PlanStep[] {
    if (!parsed) {
      return [];
    }

    const steps: PlanStep[] = [];
    parsed.steps.forEach((item) => {
      const goal = item.goal.trim();
      if (!goal) {
        return;
      }
      const suggestedTools = item.suggestedTools?.filter(
        (name) => name.length > 0,
      );
      steps.push({
        id: `step-${steps.length + 1}`,
        goal,
        suggestedTools:
          suggestedTools && suggestedTools.length > 0
            ? suggestedTools
            : undefined,
      });
    });

    return steps;
  }

  private readLatestUserText(messages: LlmMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'user') {
        return messages[index].content;
      }
    }
    return '';
  }
}

/**
 * 构建规划器的完整消息，供 Flow 在调用前冻结输入
 * @param input 会话消息、系统指令和工具
 * @param maxSteps 步骤数量上限
 * @param feedback 已有重规划反馈
 * @returns 实际发送给规划模型的消息
 * @description 与 Planner 共用，避免预算估算与真实提示词出现两套拼装逻辑。
 */
export function buildPlannerMessages(
  input: Pick<AgentLoopInput, 'messages' | 'systemPrompt' | 'tools'>,
  maxSteps: number,
  feedback: string[],
): LlmMessage[] {
  const cap = Math.max(1, Math.min(maxSteps, PLANNER_HARD_STEP_CAP));
  return [
    {
      role: 'system',
      content: [input.systemPrompt, buildTaskPlannerPrompt(cap)]
        .filter(Boolean)
        .join('\n\n'),
    },
    ...input.messages,
    {
      role: 'user',
      content: buildUserPrompt(readToolNames(input.tools), feedback),
    },
  ];
}

/**
 * 生成规划请求与历次反馈
 * @param toolNames 可用工具名称
 * @param feedback 历次重规划反馈
 * @returns 规划器的数据消息正文
 */
function buildUserPrompt(toolNames: string[], feedback: string[]): string {
  const toolLine =
    toolNames.length > 0 ? toolNames.join('、') : '（无可用工具）';
  const sections = [
    '请根据上述对话规划用户最新请求。',
    `可用工具：${toolLine}`,
  ];
  // 打回重规划时把用户历次意见拼进来，让模型据此调整拆解（而非重复上一版计划）。
  if (feedback.length > 0) {
    sections.push(
      `用户对上一版计划的反馈（请据此调整）：\n${feedback
        .map((text, index) => `${index + 1}. ${text}`)
        .join('\n')}`,
    );
  }
  return sections.join('\n\n');
}

/**
 * 读取规划器可使用的工具名称
 * @param tools 装配后的工具列表
 * @returns 非空的工具名称列表
 */
function readToolNames(tools: unknown[] | undefined): string[] {
  return (tools ?? [])
    .map((tool) => {
      if (tool && typeof tool === 'object') {
        const name = (tool as Record<string, unknown>).name;
        return typeof name === 'string' ? name : undefined;
      }
      return undefined;
    })
    .filter((name): name is string => Boolean(name));
}
