import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../../llm/llm.service';
import { KIMI_PLATFORM } from '../../../llm/providers/kimi';
import type { LlmMessage } from '../../../llm/llm.types';
import { z } from 'zod';
import { buildTaskPlannerPrompt } from '../../../../prompts';
import type { AgentLoopInput } from '../agent-loop.types';
import type { AgentPlan, PlanStep } from './plan.types';

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
   * @returns 返回结构化任务计划
   * @description 使用 Kimi 预设做一次结构化输出调用，把用户请求拆解为可执行步骤；
   * 任何失败（模型不可用/输出非法/解析为空）都回退为"单步 = 原始请求"的兜底计划，保证主链路不被规划环节拖垮。
   */
  async plan(
    input: AgentLoopInput,
    maxSteps: number,
    feedback: string[] = [],
  ): Promise<AgentPlan> {
    const userText = this.readLatestUserText(input.messages);
    const toolNames = this.readToolNames(input.tools);
    const cap = Math.max(1, Math.min(maxSteps, PLANNER_HARD_STEP_CAP));

    try {
      const parsed = await this.llmService.generateStructured(
        [
          { role: 'system', content: buildTaskPlannerPrompt(cap) },
          {
            role: 'user',
            content: this.buildUserPrompt(userText, toolNames, feedback),
          },
        ],
        planSchema,
        {
          schemaName: 'agent_plan',
          // 不覆盖 temperature：部分模型（如 kimi-for-coding）仅允许 temperature=1，交由预设/模型默认。
          request: { model: { platform: KIMI_PLATFORM } },
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

  private buildUserPrompt(
    userText: string,
    toolNames: string[],
    feedback: string[],
  ): string {
    const toolLine =
      toolNames.length > 0 ? toolNames.join('、') : '（无可用工具）';
    const sections = [`用户请求：\n${userText}`, `可用工具：${toolLine}`];
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

  private readToolNames(tools: unknown[] | undefined): string[] {
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

  private readLatestUserText(messages: LlmMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'user') {
        return messages[index].content;
      }
    }
    return '';
  }
}
