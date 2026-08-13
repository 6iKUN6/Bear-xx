import { Injectable } from '@nestjs/common';
import { createGenerateImageTool, getWeather, webSearch } from '../../tools';
import { ImageGenerationService } from '../../../images/image-generation.service';
import { ConfigService } from '@nestjs/config';
import {
  getMcDonaldsMcpToolName,
  MCDONALDS_MCP_SERVER_NAME,
} from '../../mcp/McDonalds.mcp';
import { MCDONALDS_MCP_ALLOWED_TOOL_NAMES } from '../../mcp/mcp-client-manager.service';
import type {
  CapabilityTool,
  CapabilityToolMetadata,
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
/** 麦当劳点餐工具组：不入 default，只有绑定用户级凭据后才在请求内装配。 */
export const MCDONALDS_ORDER_TOOL_GROUP = 'mcd-order';

/**
 * 能力注册表
 * @description 集中登记静态 tools / skills / subagents，以及工具组、审批与 MCP 来源元数据。
 * 用户级 MCP 工具不在启动期注册，避免任意全局 Token 进入 Agent 运行时。
 */
@Injectable()
export class CapabilityRegistry {
  private readonly tools = new Map<string, CapabilityTool>();
  private readonly toolGroups = new Map<string, string[]>();
  private readonly approvalTools = new Set<string>();
  private readonly toolMetadata = new Map<string, CapabilityToolMetadata>();
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly subagents = new Map<string, SubagentDefinition>();

  constructor(
    private readonly imageGenerationService: ImageGenerationService,
    private readonly configService: ConfigService,
  ) {
    this.registerTool(getWeather, [DEFAULT_TOOL_GROUP, WEATHER_TOOL_GROUP]);
    this.registerTool(webSearch, [DEFAULT_TOOL_GROUP, SEARCH_TOOL_GROUP]);
    this.registerTool(
      createGenerateImageTool(this.imageGenerationService),
      [IMAGE_TOOL_GROUP],
      { requiresApproval: true },
    );
    // 组本身是稳定的可配置能力；实际远程工具仅在用户有活跃凭据时由 resolver 按请求加载。
    this.toolGroups.set(MCDONALDS_ORDER_TOOL_GROUP, []);
  }

  /**
   * 注册静态工具并归入工具组
   * @param tool LangChain 工具对象
   * @param groups 该工具所属的工具组名称
   * @param options 工具策略，如是否需要人工审批
   * @returns 无返回值
   * @description 静态工具随应用生命周期常驻；用户级 MCP 工具不能通过此方法长期写入全局 registry。
   */
  registerTool(
    tool: CapabilityTool,
    groups: string[] = [],
    options?: {
      requiresApproval?: boolean;
      metadata?: CapabilityToolMetadata;
    },
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
    if (options?.metadata) {
      this.toolMetadata.set(tool.name, { ...options.metadata });
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

  /** 按名称获取静态工具 */
  getTool(name: string): CapabilityTool | undefined {
    return this.tools.get(name);
  }

  /** 按名称获取静态工具组的工具列表 */
  getToolsByGroup(group: string): CapabilityTool[] {
    return (this.toolGroups.get(group) ?? [])
      .map((name) => this.tools.get(name))
      .filter((tool): tool is CapabilityTool => Boolean(tool));
  }

  /**
   * 判断用户是否可使用指定工具组
   * @param group 工具组标识
   * @param userId 当前 Litter-Bear 用户ID
   * @param mcdonaldsCredentialId 当前任务锁定的用户级麦当劳凭据ID
   * @returns 当前用户有权使用该工具组时返回 true
   * @description 麦当劳工具组只以任务锁定的活跃凭据开放，不复用进程级 Token 属主限制。
   */
  canUseToolGroup(
    group: string,
    _userId: string | undefined,
    mcdonaldsCredentialId?: string,
  ): boolean {
    return (
      group !== MCDONALDS_ORDER_TOOL_GROUP || Boolean(mcdonaldsCredentialId)
    );
  }

  /**
   * 判断用户是否可使用指定工具
   * @param toolName 运行时工具名
   * @param userId 当前 Litter-Bear 用户ID
   * @param mcdonaldsCredentialId 当前任务锁定的用户级麦当劳凭据ID
   * @returns 当前用户有权使用该工具时返回 true
   * @description skill 直接绑定 MCP 工具时同样需要任务凭据，避免绕过工具组授权。
   */
  canUseTool(
    toolName: string,
    _userId: string | undefined,
    mcdonaldsCredentialId?: string,
  ): boolean {
    const metadata = this.getToolMetadata(toolName);
    return (
      metadata?.mcpServer !== MCDONALDS_MCP_SERVER_NAME ||
      Boolean(mcdonaldsCredentialId)
    );
  }

  /** 列出全部静态注册工具 */
  listTools(): CapabilityTool[] {
    return [...this.tools.values()];
  }

  /** 列出全部静态工具名 */
  listToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** 列出全部工具组名 */
  listToolGroups(): string[] {
    return [...this.toolGroups.keys()];
  }

  /** 是否存在任何静态工具 */
  hasTools(): boolean {
    return this.tools.size > 0;
  }

  /**
   * 指定工具是否需要人工审批
   * @param name 运行时工具名称
   * @returns 需要审批时返回 true
   * @description 用户级 MCP 工具不会登记到全局 set；下单工具基于受审核原始工具名维持固定的 HITL 策略。
   */
  requiresApproval(name: string): boolean {
    return (
      this.approvalTools.has(name) ||
      this.getToolMetadata(name)?.mcpTool === 'create-order'
    );
  }

  /**
   * 获取工具来源元数据
   * @param name 运行时工具名
   * @returns 返回 MCP server 与原始工具名；普通内置工具返回 undefined
   * @description 动态麦当劳工具按稳定前缀识别，实际工具白名单仍由 MCP manager 在加载时验证。
   */
  getToolMetadata(name: string): CapabilityToolMetadata | undefined {
    const metadata = this.toolMetadata.get(name);
    if (metadata) {
      return { ...metadata };
    }
    const mcpTool = getMcDonaldsMcpToolName(
      name,
      this.configService.get<string>('MCDONALDS_MCP_TOOL_PREFIX')?.trim() ?? '',
    );
    if (
      !mcpTool ||
      !MCDONALDS_MCP_ALLOWED_TOOL_NAMES.includes(mcpTool as never)
    ) {
      return undefined;
    }
    return {
      mcpServer: MCDONALDS_MCP_SERVER_NAME,
      mcpTool,
    };
  }

  /** 列出需要人工审批的静态工具名 */
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
