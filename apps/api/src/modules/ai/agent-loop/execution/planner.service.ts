import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../../llm/llm.service';
import { KIMI_PLATFORM } from '../../../llm/providers/kimi';
import type { LlmMessage } from '../../../llm/llm.types';
import type { AgentLoopInput } from '../agent-loop.types';
import type { AgentPlan, PlanStep } from './plan.types';

/** 模型规划最多产出的步骤数上限（再受 maxSteps 约束） */
const PLANNER_HARD_STEP_CAP = 5;

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
  async plan(input: AgentLoopInput, maxSteps: number): Promise<AgentPlan> {
    const userText = this.readLatestUserText(input.messages);
    const toolNames = this.readToolNames(input.tools);
    const cap = Math.max(1, Math.min(maxSteps, PLANNER_HARD_STEP_CAP));

    try {
      const raw = await this.llmService.generateChatText(
        [
          { role: 'system', content: this.buildSystemPrompt(cap) },
          { role: 'user', content: this.buildUserPrompt(userText, toolNames) },
        ],
        // 不覆盖 temperature：部分模型（如 kimi-for-coding）仅允许 temperature=1，交由预设/模型默认。
        { model: { platform: KIMI_PLATFORM } },
        { abortSignal: input.abortSignal },
      );

      const steps = this.parseSteps(raw).slice(0, cap);
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

  private buildSystemPrompt(cap: number): string {
    return [
      '你是任务规划助手。把用户请求拆解为有序、可执行的步骤。',
      `最多输出 ${cap} 个步骤，步骤应聚焦、互不重复，能覆盖完成请求所需的关键动作。`,
      '只输出 JSON，禁止输出解释或 Markdown 代码块，格式：',
      '{"steps":[{"goal":"步骤目标","suggestedTools":["可选的工具名"]}]}',
    ].join('\n');
  }

  private buildUserPrompt(userText: string, toolNames: string[]): string {
    const toolLine =
      toolNames.length > 0 ? toolNames.join('、') : '（无可用工具）';
    return [`用户请求：\n${userText}`, `可用工具：${toolLine}`].join('\n\n');
  }

  /**
   * 解析模型返回的步骤 JSON
   * @param raw 模型原始输出
   * @returns 返回解析后的步骤列表；无法解析时返回空数组
   * @description 兼容纯 JSON 与被 Markdown 代码块包裹的 JSON，并对 steps 字段做结构校验。
   */
  private parseSteps(raw: string): PlanStep[] {
    const json = this.extractJson(raw);
    if (!json) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return [];
    }

    const stepsRaw = this.readStepsField(parsed);
    if (!Array.isArray(stepsRaw)) {
      return [];
    }

    const steps: PlanStep[] = [];
    stepsRaw.forEach((item, index) => {
      const goal = this.readStepGoal(item);
      if (!goal) {
        return;
      }
      steps.push({
        id: `step-${index + 1}`,
        goal,
        suggestedTools: this.readSuggestedTools(item),
      });
    });

    return steps;
  }

  private readStepsField(parsed: unknown): unknown {
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === 'object') {
      return (parsed as Record<string, unknown>).steps;
    }
    return undefined;
  }

  private readStepGoal(item: unknown): string | undefined {
    if (typeof item === 'string') {
      return item.trim() || undefined;
    }
    if (item && typeof item === 'object') {
      const goal = (item as Record<string, unknown>).goal;
      if (typeof goal === 'string' && goal.trim()) {
        return goal.trim();
      }
    }
    return undefined;
  }

  private readSuggestedTools(item: unknown): string[] | undefined {
    if (!item || typeof item !== 'object') {
      return undefined;
    }
    const value = (item as Record<string, unknown>).suggestedTools;
    if (!Array.isArray(value)) {
      return undefined;
    }
    const names = value.filter(
      (name): name is string => typeof name === 'string' && name.length > 0,
    );
    return names.length > 0 ? names : undefined;
  }

  private extractJson(raw: string): string | undefined {
    if (!raw) {
      return undefined;
    }

    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1] : raw;

    const firstObject = body.indexOf('{');
    const firstArray = body.indexOf('[');
    const candidates = [firstObject, firstArray].filter((i) => i >= 0);
    if (candidates.length === 0) {
      return undefined;
    }

    const start = Math.min(...candidates);
    const lastObject = body.lastIndexOf('}');
    const lastArray = body.lastIndexOf(']');
    const end = Math.max(lastObject, lastArray);
    if (end <= start) {
      return undefined;
    }

    return body.slice(start, end + 1);
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
