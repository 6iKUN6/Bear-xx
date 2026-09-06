import { Injectable } from '@nestjs/common';
import { AgentFlowVersionStatus, StreamTaskStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { validateFlowDefinition } from '../agent-flow/definition/flow-definition.validator';
import type { ModelPresetReferencesResponseDto } from './dto/model-preset.dto';

/** 模型预设引用集合，以 presetId 为键。 */
export type ModelPresetReferencesById = Map<
  string,
  ModelPresetReferencesResponseDto
>;

/**
 * 模型预设引用查询
 * @description 统一扫描 Agent 默认模型和可编辑/可执行 FlowVersion 中的显式模型引用，供删除
 * 护栏与连接影响提示复用同一判据。
 */
@Injectable()
export class ModelPresetReferenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查询单个模型预设的引用
   * @param presetId 模型预设稳定业务 ID
   * @returns 返回 Agent 数量、逻辑 Flow 数量与具体引用位置
   * @description Flow 数量按逻辑 Flow 去重，items 仍保留每个版本，便于管理员定位草稿或发布版本。
   */
  async findByPresetId(
    presetId: string,
  ): Promise<ModelPresetReferencesResponseDto> {
    const references = await this.findByPresetIds([presetId]);
    return references.get(presetId) ?? this.emptyReferences();
  }

  /**
   * 批量查询模型预设引用
   * @param presetIds 待查询的稳定模型预设 ID
   * @returns 返回以 presetId 为键的引用汇总
   * @description 一次读取 Agent 与 FlowVersion，避免连接列表为每个模型执行独立查询。
   */
  async findByPresetIds(
    presetIds: readonly string[],
  ): Promise<ModelPresetReferencesById> {
    const uniqueIds = [...new Set(presetIds)];
    const result = new Map(
      uniqueIds.map((presetId) => [presetId, this.emptyReferences()]),
    );
    if (uniqueIds.length === 0) {
      return result;
    }

    const [agents, versions, tasks] = await Promise.all([
      this.prisma.agent.findMany({
        where: {
          OR: [
            { defaultModelPreset: { presetId: { in: uniqueIds } } },
            {
              allowedModelPresets: {
                some: { modelPreset: { presetId: { in: uniqueIds } } },
              },
            },
          ],
        },
        select: {
          id: true,
          name: true,
          defaultModelPreset: { select: { presetId: true } },
          allowedModelPresets: {
            select: { modelPreset: { select: { presetId: true } } },
          },
        },
      }),
      this.prisma.agentFlowVersion.findMany({
        where: {
          status: {
            in: [
              AgentFlowVersionStatus.DRAFT,
              AgentFlowVersionStatus.PUBLISHED,
            ],
          },
        },
        select: {
          id: true,
          version: true,
          status: true,
          definition: true,
          flow: { select: { id: true, name: true } },
        },
      }),
      this.prisma.streamTask.findMany({
        where: {
          resolvedAgentModelPresetId: { in: uniqueIds },
          status: {
            in: [
              StreamTaskStatus.PENDING,
              StreamTaskStatus.STREAMING,
              StreamTaskStatus.PAUSED,
              StreamTaskStatus.WAITING_HUMAN,
            ],
          },
        },
        select: { id: true, status: true, resolvedAgentModelPresetId: true },
      }),
    ]);

    for (const agent of agents) {
      const referencedPresetIds = new Set([
        ...(agent.defaultModelPreset
          ? [agent.defaultModelPreset.presetId]
          : []),
        ...agent.allowedModelPresets.map((item) => item.modelPreset.presetId),
      ]);
      for (const presetId of referencedPresetIds) {
        result.get(presetId)?.items.push({
          type: 'agent',
          id: agent.id,
          name: agent.name,
          versionId: null,
          version: null,
          status: null,
        });
      }
    }

    for (const version of versions) {
      const parsed = validateFlowDefinition(version.definition);
      if (!parsed.success) continue;
      const referencedPresetIds = new Set<string>();
      for (const node of parsed.definition.nodes) {
        const presetId =
          node.type === 'agent'
            ? node.config.modelPreset
            : node.type === 'plan'
              ? node.config.modelPreset
              : node.type === 'plan-loop'
                ? node.config.executor.modelPreset
                : node.type === 'approval' && node.config.policy === 'model'
                  ? node.config.modelPreset
                  : node.type === 'synthesize'
                    ? node.config.modelPreset
                    : undefined;
        if (presetId && presetId !== 'agent-default') {
          referencedPresetIds.add(presetId);
        }
      }
      for (const presetId of referencedPresetIds) {
        result.get(presetId)?.items.push({
          type: 'flow',
          id: version.flow.id,
          name: version.flow.name,
          versionId: version.id,
          version: version.version,
          status: version.status,
        });
      }
    }

    for (const task of tasks) {
      if (!task.resolvedAgentModelPresetId) continue;
      result.get(task.resolvedAgentModelPresetId)?.items.push({
        type: 'task',
        id: task.id,
        name: `运行中任务 ${task.id}`,
        versionId: null,
        version: null,
        status: task.status,
      });
    }

    for (const references of result.values()) {
      references.agentCount = references.items.filter(
        (item) => item.type === 'agent',
      ).length;
      references.flowCount = new Set(
        references.items
          .filter((item) => item.type === 'flow')
          .map((item) => item.id),
      ).size;
      references.taskCount = references.items.filter(
        (item) => item.type === 'task',
      ).length;
    }
    return result;
  }

  /**
   * 创建空引用结果
   * @returns 返回可安全追加引用项的空汇总
   * @description 每次返回新数组，避免多个 presetId 共享同一 items 引用。
   */
  private emptyReferences(): ModelPresetReferencesResponseDto {
    return { agentCount: 0, flowCount: 0, taskCount: 0, items: [] };
  }
}
