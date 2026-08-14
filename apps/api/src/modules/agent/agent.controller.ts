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
import { AgentService } from './agent.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AgentResponseDto } from './dto/agent-response.dto';
import { EmptyResultDto } from '../../common/dto/empty-result.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('智能体')
@ApiBearerAuth()
@Controller('agents')
@UseGuards(JwtAuthGuard)
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get()
  @ApiOperation({
    summary: '获取智能体列表',
    description: '供客户端选择智能体',
  })
  @ApiOkResponse({ type: AgentResponseDto, isArray: true })
  async list() {
    return this.agentService.list();
  }

  @Get(':id')
  @ApiOperation({ summary: '获取智能体详情' })
  @ApiOkResponse({ type: AgentResponseDto })
  async get(@Param('id') id: string) {
    return this.agentService.get(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: '创建智能体（管理员）' })
  @ApiOkResponse({ type: AgentResponseDto })
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateAgentDto) {
    return this.agentService.create(dto, userId);
  }

  /**
   * 设置全局默认智能体
   * @param id 要设为默认智能体的智能体 ID
   * @returns 返回设置成功后的智能体信息
   * @description 仅管理员可调用；该默认项只用于未指定 agentId 的普通聊天。
   */
  @Patch(':id/default')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: '设置全局默认智能体（管理员）' })
  @ApiOkResponse({ type: AgentResponseDto })
  async setDefault(@Param('id') id: string) {
    return this.agentService.setDefault(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: '更新智能体（管理员）' })
  @ApiOkResponse({ type: AgentResponseDto })
  async update(@Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.agentService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除智能体（管理员）' })
  @ApiOkResponse({ type: EmptyResultDto })
  async remove(@Param('id') id: string) {
    await this.agentService.remove(id);
    return { success: true };
  }
}
