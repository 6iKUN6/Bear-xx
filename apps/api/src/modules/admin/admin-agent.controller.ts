import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { EmptyResultDto } from '../../common/dto/empty-result.dto';
import { AgentService } from '../agent/agent.service';
import { CreateAgentDto } from '../agent/dto/create-agent.dto';
import { UpdateAgentDto } from '../agent/dto/update-agent.dto';
import { AgentResponseDto } from '../agent/dto/agent-response.dto';

@ApiTags('管理-智能体')
@ApiBearerAuth()
@Controller('admin/agents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class AdminAgentController {
  constructor(private readonly service: AgentService) {}

  /** 获取全部智能体及原始开放配置 */
  @Get()
  @ApiOperation({ summary: '智能体管理列表' })
  @ApiOkResponse({ type: AgentResponseDto, isArray: true })
  list() {
    return this.service.listForAdmin();
  }

  /** 获取隐藏智能体的后台详情 */
  @Get(':id')
  @ApiOperation({ summary: '智能体管理详情' })
  @ApiOkResponse({ type: AgentResponseDto })
  get(@Param('id') id: string) {
    return this.service.getForAdmin(id);
  }

  /** 创建智能体 */
  @Post()
  @ApiOperation({ summary: '创建智能体' })
  @ApiOkResponse({ type: AgentResponseDto })
  create(@Body() dto: CreateAgentDto, @CurrentUser('id') actorId: string) {
    return this.service.create(dto, actorId);
  }

  /** 更新智能体开放策略与执行配置 */
  @Patch(':id')
  @ApiOperation({ summary: '更新智能体' })
  @ApiOkResponse({ type: AgentResponseDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAgentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.service.update(id, dto, actorId);
  }

  /** 设置默认智能体 */
  @Patch(':id/default')
  @ApiOperation({ summary: '设置默认智能体' })
  @ApiOkResponse({ type: AgentResponseDto })
  setDefault(@Param('id') id: string, @CurrentUser('id') actorId: string) {
    return this.service.setDefault(id, actorId);
  }

  /** 删除非默认智能体 */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除智能体' })
  @ApiOkResponse({ type: EmptyResultDto })
  async remove(@Param('id') id: string, @CurrentUser('id') actorId: string) {
    await this.service.remove(id, actorId);
    return { success: true };
  }
}
