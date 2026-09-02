import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AdminObservabilityService } from './admin-observability.service';
import {
  ObservabilityRangeQueryDto,
  RecentTasksQueryDto,
} from './dto/observability-query.dto';
import {
  AgentUsageDto,
  ErrorCategoryCountDto,
  ObservabilityOverviewDto,
  RecentTasksDto,
  TaskDetailDto,
  ToolUsageDto,
} from './dto/observability-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('管理-观测')
@ApiBearerAuth()
@Controller('admin/observability')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class AdminController {
  constructor(private readonly observability: AdminObservabilityService) {}

  @Get('overview')
  @ApiOperation({ summary: '总览：任务量/状态分布/成功率/平均时长（管理员）' })
  @ApiOkResponse({ type: ObservabilityOverviewDto })
  overview(@Query() query: ObservabilityRangeQueryDto) {
    return this.observability.overview(query.days);
  }

  @Get('agents')
  @ApiOperation({ summary: '按智能体聚合用量（管理员）' })
  @ApiOkResponse({ type: AgentUsageDto, isArray: true })
  agents(@Query() query: ObservabilityRangeQueryDto) {
    return this.observability.agentUsage(query.days);
  }

  @Get('tools')
  @ApiOperation({ summary: '按工具聚合调用（管理员）' })
  @ApiOkResponse({ type: ToolUsageDto, isArray: true })
  tools(@Query() query: ObservabilityRangeQueryDto) {
    return this.observability.toolUsage(query.days);
  }

  @Get('errors')
  @ApiOperation({ summary: '失败任务按错误类别聚合（管理员）' })
  @ApiOkResponse({ type: ErrorCategoryCountDto, isArray: true })
  errors(@Query() query: ObservabilityRangeQueryDto) {
    return this.observability.errorBreakdown(query.days);
  }

  @Get('tasks')
  @ApiOperation({ summary: '近期任务分页列表（管理员）' })
  @ApiOkResponse({ type: RecentTasksDto })
  tasks(@Query() query: RecentTasksQueryDto) {
    return this.observability.recentTasks(
      query.days,
      query.limit,
      query.cursor,
    );
  }

  @Get('tasks/:id')
  @ApiOperation({ summary: '单任务详情 + 执行轨迹（管理员）' })
  @ApiOkResponse({ type: TaskDetailDto })
  taskDetail(@Param('id') id: string) {
    return this.observability.taskDetail(id);
  }
}
