import { Injectable } from '@nestjs/common';
import type { StepExecutionResult } from './plan.types';

/** 步骤评估上下文 */
export interface StepEvaluationContext {
  /** 已完成的步骤数（从 1 开始计） */
  stepsDone: number;
  /** 步骤预算上限 */
  maxSteps: number;
  /** 计划总步骤数 */
  plannedSteps: number;
  /** 最近一步的执行结果 */
  lastResult: StepExecutionResult;
}

/**
 * 步骤评估器
 * @description 判断"信息是否已足够，可以停止继续 loop"。Plan 模式跑完所有步骤即止，
 * 该评估器主要服务 Hybrid 模式的动态提前结束。当前为启发式实现，后续可替换为 LLM 判定。
 */
export interface StepEvaluator {
  enough(context: StepEvaluationContext): boolean;
}

export const STEP_EVALUATOR = Symbol('STEP_EVALUATOR');

/**
 * 启发式步骤评估器
 * @description 不额外调用模型，仅依据预算与最近一步的表现判断是否收尾：
 * - 达到步骤预算或计划步骤已跑完 → 停止；
 * - 最近一步产出了实质文本且未再触发工具调用 → 认为信息足够，提前停止。
 */
@Injectable()
export class HeuristicStepEvaluator implements StepEvaluator {
  enough(context: StepEvaluationContext): boolean {
    if (context.stepsDone >= context.maxSteps) {
      return true;
    }
    if (context.stepsDone >= context.plannedSteps) {
      return true;
    }

    const { text, hadToolCalls } = context.lastResult;
    return text.trim().length > 0 && !hadToolCalls;
  }
}
