import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CapabilityRegistry } from '../ai/agent-loop';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AgentCapabilitiesDto } from './dto/capability-response.dto';

/**
 * 管理-能力闭集查询
 * @description 把能力注册表（工具组/工具）与模型预设闭集投影给 admin 前端，供智能体表单与
 * Flow 节点编辑渲染可选项，避免前端硬编码与后端闭集漂移。
 */
@ApiTags('管理-能力')
@ApiBearerAuth()
@Controller('admin/capabilities')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminCapabilityController {
  constructor(
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly modelRegistry: LlmModelRegistryService,
  ) {}

  @Get()
  @ApiOperation({ summary: '工具组、工具与模型预设闭集（管理员）' })
  @ApiOkResponse({ type: AgentCapabilitiesDto })
  capabilities(): AgentCapabilitiesDto {
    return {
      toolGroups: this.capabilityRegistry.listToolGroups().map((group) => ({
        name: group,
        tools: this.capabilityRegistry.getToolsByGroup(group).map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          requiresApproval: this.capabilityRegistry.requiresApproval(tool.name),
        })),
      })),
      // 与 FlowRuntimeValidator 用同一个判据，避免选择器列出发布期会被拒的预设
      modelPresets: this.modelRegistry.listAvailableModels().map((preset) => ({
        id: preset.id,
        model: preset.model,
      })),
    };
  }
}
