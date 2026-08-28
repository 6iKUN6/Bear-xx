import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { describeToolGroups } from '../ai/agent-loop/capability/tool-group-labels';
import { groupRouterPrompt } from '../../prompts';
import { resolveBoundFlowToolGroups } from '../agent-flow/definition/flow-tool-groups';

const ROUTER_TEMPERATURE = 0;
const ROUTER_MAX_OUTPUT_TOKENS = 100;

/** 路由输出契约：约束模型输出，同时用于校验（含降级路径） */
const groupRouteSchema = z.object({
  agentId: z.string().min(1).describe('选中成员的 id，必须来自给定成员列表'),
  reason: z.string().max(50).optional().describe('一句话理由'),
});

/** 路由结果来源：model=模型决策生效；fallback=降级为兜底成员 */
export type GroupRouteSource = 'model' | 'fallback';

/** 路由上下文：用于判断「延续上文」类消息该由谁接 */
export interface GroupRouteContext {
  /** 上一轮回答者（延续类消息优先沿用） */
  lastAgentId?: string;
  /** 最近若干轮对话（时间正序，仅用于判断指代，不做完整上下文） */
  recentTurns?: Array<{
    role: 'user' | 'assistant';
    content: string;
    agentName?: string;
  }>;
}

export interface GroupRouteResult {
  agentId: string;
  /** 路由理由（透出到 task.created payload 供前端/trace 展示） */
  reason?: string;
  /**
   * 结果来源
   * @description 降级是静默的（模型不可用/输出非法都回退第一个成员），
   * 不标记就无法区分「模型选了它」和「路由压根没生效」——线上表现同为
   * 「总是第一个成员回答」。透出此字段用于观测真实生效率。
   */
  source: GroupRouteSource;
}

/**
 * 群聊回答者路由器
 * @description 群聊消息未显式指定回答者（无 @、无固定默认回答者）时，
 * 用一次低成本结构化分类调用从成员中选人——不是「主持人 agent」：
 * 选中者以自己的身份走完整回答管道，路由只占几百毫秒。
 * 任何失败（模型不可用/输出不合法）回退第一个成员，绝不阻塞发送链路。
 */
@Injectable()
export class GroupRouterService {
  private readonly logger = new Logger(GroupRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
  ) {}

  /**
   * 为群聊消息选择回答者
   * @param content 用户消息
   * @param memberIds 群成员 agent id 列表（非空）
   * @param context 可选路由上下文（上一轮回答者与最近对话，用于延续类消息）
   * @returns 返回选中的成员与理由；成员唯一时直接短路
   */
  async route(
    content: string,
    memberIds: string[],
    context?: GroupRouteContext,
  ): Promise<GroupRouteResult> {
    const fallback: GroupRouteResult = {
      agentId: memberIds[0],
      source: 'fallback',
    };
    // 成员唯一：无需路由，这是确定性结果而非降级
    if (memberIds.length === 1) {
      return { agentId: memberIds[0], source: 'model' };
    }

    try {
      const members = await this.prisma.agent.findMany({
        where: { id: { in: memberIds }, enabled: true },
        select: {
          id: true,
          name: true,
          description: true,
          isDefault: true,
          // 能力从绑定 Flow 的图上推导：Agent.toolGroups 那一列已删除，工具只在
          // Flow 节点上声明。一并 select 进来而不是逐个再查，避免 N+1
          defaultFlowVersion: { select: { definition: true } },
        },
      });
      if (members.length === 0) {
        return fallback;
      }
      if (members.length === 1) {
        return { agentId: members[0].id, source: 'model' };
      }

      const memberLines = members
        .map((m) => {
          const isLast = context?.lastAgentId === m.id;
          return `- id: ${m.id} | 名称: ${m.name}${m.isDefault ? '（默认）' : ''}${isLast ? '（上一轮回答者）' : ''} | 简介: ${m.description || '无'} | 能力: ${describeToolGroups(resolveBoundFlowToolGroups(m.defaultFlowVersion?.definition))}`;
        })
        .join('\n');

      const parsed = await this.llmService.generateStructured(
        [
          { role: 'system', content: groupRouterPrompt },
          {
            role: 'user',
            content: this.buildUserPrompt(content, memberLines, context),
          },
        ],
        groupRouteSchema,
        {
          schemaName: 'group_route',
          request: {
            generation: {
              temperature: ROUTER_TEMPERATURE,
              maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
            },
          },
        },
      );

      // schema 已保证形状，仍需业务校验：模型可能给出不在成员列表里的 id（幻觉）
      if (parsed && members.some((m) => m.id === parsed.agentId)) {
        return {
          agentId: parsed.agentId,
          reason: parsed.reason,
          source: 'model',
        };
      }
      this.logger.warn(
        `Group route output invalid, fallback: ${parsed?.agentId ?? 'unparsable'}`,
      );
      return fallback;
    } catch (error) {
      this.logger.warn(
        `Group route failed, fallback to first member: ${(error as Error).message}`,
      );
      return fallback;
    }
  }

  /**
   * 拼装路由用户提示词
   * @description 带上最近几轮对话，使「再来一张」「换个风格」这类指代能被判定为
   * 延续上文（否则只看最新一条必然选错人）。上下文只取尾部若干轮并截断，
   * 路由是低成本调用，不做完整历史。
   */
  private buildUserPrompt(
    content: string,
    memberLines: string,
    context?: GroupRouteContext,
  ): string {
    const sections = [`群成员：\n${memberLines}`];

    const turns = context?.recentTurns ?? [];
    if (turns.length > 0) {
      const history = turns
        .map((turn) => {
          const speaker =
            turn.role === 'user' ? '用户' : turn.agentName || '智能体';
          return `${speaker}：${turn.content.slice(0, 120)}`;
        })
        .join('\n');
      sections.push(`最近对话：\n${history}`);
    }

    sections.push(`用户消息：${content.slice(0, 500)}`);
    return sections.join('\n\n');
  }
}
