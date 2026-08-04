import { Injectable } from '@nestjs/common';
import {
  createEditImageTool,
  createGenerateImageTool,
  getWeather,
  webSearch,
} from '../../tools';
import { ImageGenerationService } from '../../../images/image-generation.service';
import type {
  CapabilityTool,
  SkillDefinition,
  SubagentDefinition,
} from './capability.types';

/** 默认工具组：无显式能力要求时可用的基础工具集合 */
export const DEFAULT_TOOL_GROUP = 'default';
/** 天气工具组：仅天气查询 */
export const WEATHER_TOOL_GROUP = 'weather';
/** 搜索工具组：仅联网搜索 */
export const SEARCH_TOOL_GROUP = 'search';
/** 生图工具组：AI 文生图（不入 default，按 agent 显式分配） */
export const IMAGE_TOOL_GROUP = 'image-gen';

/**
 * 能力注册表
 * @description 集中登记可用的 tools / skills / subagents，作为路由与能力解析的闭集来源，
 * 避免决策层声明出并不存在的能力。P2 仅注册基础工具，skills/subagents 预留注册入口。
 */
@Injectable()
export class CapabilityRegistry {
  private readonly tools = new Map<string, CapabilityTool>();
  private readonly toolGroups = new Map<string, string[]>();
  private readonly approvalTools = new Set<string>();
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly subagents = new Map<string, SubagentDefinition>();

  constructor(private readonly imageGenerationService: ImageGenerationService) {
    // P5a 演示：给 getWeather 开启人工审批，使"深圳天气"流程即可端到端验证 HITL。
    // 真实策略应按工具语义配置（只读工具免审批、写类/高风险工具需审批）。
    // 每个工具同时归入 default（全量）与语义组（细粒度），供 Agent.toolGroups 按需组合。
    this.registerTool(getWeather, [DEFAULT_TOOL_GROUP, WEATHER_TOOL_GROUP], {
      requiresApproval: true,
    });
    // 联网搜索为只读、低风险能力，免审批直接执行。
    this.registerTool(webSearch, [DEFAULT_TOOL_GROUP, SEARCH_TOOL_GROUP]);
    // 生图不进 default：有真实费用与耗时，只给显式配置了 image-gen 组的 agent（如「画师」）。
    this.registerTool(createGenerateImageTool(this.imageGenerationService), [
      IMAGE_TOOL_GROUP,
    ]);
    this.registerTool(createEditImageTool(this.imageGenerationService), [
      IMAGE_TOOL_GROUP,
    ]);
  }

  /**
   * 注册工具并归入若干工具组
   * @param tool LangChain 工具对象
   * @param groups 该工具所属的工具组名称
   * @param options 工具策略，如是否需要人工审批
   */
  registerTool(
    tool: CapabilityTool,
    groups: string[] = [],
    options?: { requiresApproval?: boolean },
  ): void {
    this.tools.set(tool.name, tool);
    for (const group of groups) {
      const names = this.toolGroups.get(group) ?? [];
      if (!names.includes(tool.name)) {
        names.push(tool.name);
      }
      this.toolGroups.set(group, names);
    }
    if (options?.requiresApproval) {
      this.approvalTools.add(tool.name);
    }
  }

  /** 注册技能（预留） */
  registerSkill(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  /** 注册子 agent（预留） */
  registerSubagent(subagent: SubagentDefinition): void {
    this.subagents.set(subagent.name, subagent);
  }

  /** 按名称获取工具 */
  getTool(name: string): CapabilityTool | undefined {
    return this.tools.get(name);
  }

  /** 按工具组获取工具列表 */
  getToolsByGroup(group: string): CapabilityTool[] {
    return (this.toolGroups.get(group) ?? [])
      .map((name) => this.tools.get(name))
      .filter((tool): tool is CapabilityTool => Boolean(tool));
  }

  /** 列出全部已注册工具 */
  listTools(): CapabilityTool[] {
    return [...this.tools.values()];
  }

  /** 列出全部工具名 */
  listToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** 列出全部工具组名 */
  listToolGroups(): string[] {
    return [...this.toolGroups.keys()];
  }

  /** 是否存在任何可用工具 */
  hasTools(): boolean {
    return this.tools.size > 0;
  }

  /** 指定工具是否需要人工审批 */
  requiresApproval(name: string): boolean {
    return this.approvalTools.has(name);
  }

  /** 列出需要人工审批的工具名 */
  listApprovalToolNames(): string[] {
    return [...this.approvalTools];
  }

  /** 按名称获取技能 */
  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /** 列出全部已注册技能名称 */
  listSkillNames(): string[] {
    return [...this.skills.keys()];
  }
}
