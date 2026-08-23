import { Injectable } from '@nestjs/common';
import type {
  FlowDefinition,
  FlowDefinitionPreset,
} from '@litter-bear/types/agent-flow';
import { createFlowDefinitionPreset } from '../definition/flow-definition.templates';

const FLOW_PRESETS: readonly FlowDefinitionPreset[] = [
  // blank 排在最前：从空白起步比从某个预设改起更常用
  'blank',
  'direct',
  'react',
  'plan_execute',
  'hybrid',
];

/**
 * 内置 Flow 模板注册表
 * @description 统一暴露 Direct、ReAct、Plan Execute 与 Hybrid 的标准 JSON 模板，不让旧策略名称直接进入新 Flow 运行时。
 */
@Injectable()
export class FlowTemplateRegistry {
  /**
   * 列出可创建的内置 Flow 模板
   * @returns 返回固定顺序的预设标识列表
   * @description 返回新数组以避免调用方修改注册表内部闭集。
   */
  list(): FlowDefinitionPreset[] {
    return [...FLOW_PRESETS];
  }

  /**
   * 获取一个内置模板的独立副本
   * @param preset 已支持的预设标识
   * @returns 返回可直接进入 FlowDefinition 校验器的 JSON 副本
   * @description 每次都重新构造模板，调用方修改返回值不会污染后续任务或管理端草稿。
   */
  get(preset: FlowDefinitionPreset): FlowDefinition {
    return createFlowDefinitionPreset(preset);
  }
}
