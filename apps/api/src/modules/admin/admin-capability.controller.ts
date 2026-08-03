import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CapabilityRegistry } from '../ai/agent-loop';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AgentCapabilitiesDto } from './dto/capability-response.dto';

/**
 * 管理-能力闭集查询
 * @description 把能力注册表（工具组/工具）投影给 admin 前端，供智能体表单渲染
 * 可选项，避免前端硬编码与后端闭集漂移。
 */
@ApiTags('管理-能力')
@ApiBearerAuth()
@Controller('admin/capabilities')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminCapabilityController {
  constructor(private readonly capabilityRegistry: CapabilityRegistry) {}

  @Get()
  @ApiOperation({ summary: '工具组与工具闭集（管理员）' })
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
    };
  }
}
