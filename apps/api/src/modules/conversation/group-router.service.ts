import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { groupRouterPrompt } from '../../prompts';

const ROUTER_TEMPERATURE = 0;
const ROUTER_MAX_OUTPUT_TOKENS = 100;

/** 路由输出契约：约束模型输出，同时用于校验（含降级路径） */
const groupRouteSchema = z.object({
  agentId: z.string().min(1).describe('选中成员的 id，必须来自给定成员列表'),
  reason: z.string().max(50).optional().describe('一句话理由'),
});

/** 路由结果来源：model=模型决策生效；fallback=降级为兜底成员 */
export type GroupRouteSource = 'model' | 'fallback';

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
   * @returns 返回选中的成员与理由；成员唯一时直接短路
   */
  async route(content: string, memberIds: string[]): Promise<GroupRouteResult> {
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
          toolGroups: true,
          isDefault: true,
        },
      });
      if (members.length === 0) {
        return fallback;
      }
      if (members.length === 1) {
        return { agentId: members[0].id, source: 'model' };
      }

      const memberLines = members
        .map(
          (m) =>
            `- id: ${m.id} | 名称: ${m.name}${m.isDefault ? '（默认）' : ''} | 简介: ${m.description || '无'} | 能力: ${m.toolGroups.join(',') || '通用对话'}`,
        )
        .join('\n');

      const parsed = await this.llmService.generateStructured(
        [
          { role: 'system', content: groupRouterPrompt },
          {
            role: 'user',
            content: `群成员：\n${memberLines}\n\n用户消息：${content.slice(0, 500)}`,
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
}
