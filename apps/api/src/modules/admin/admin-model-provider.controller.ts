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
import { Roles } from '../../common/decorators/roles.decorator';
import { EmptyResultDto } from '../../common/dto/empty-result.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  CreateModelPresetDto,
  CreateModelProviderConnectionDto,
  ModelPresetResponseDto,
  ModelProviderConnectionProbeResultDto,
  ModelProviderConnectionResponseDto,
  ModelProviderTemplateResponseDto,
  ProbeModelProviderConnectionDto,
  UpdateModelProviderConnectionDto,
} from './dto/model-preset.dto';
import { ModelPresetService } from './model-preset.service';
import { ModelProviderConnectionService } from './model-provider-connection.service';

@ApiTags('管理-模型供应商')
@ApiBearerAuth()
@Controller('admin/model-provider-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminModelProviderTemplateController {
  constructor(private readonly service: ModelProviderConnectionService) {}

  /**
   * 列出内置供应商模板
   * @returns 返回默认 URL、协议闭集和推荐模型
   * @description 模板不包含任何数据库连接或密钥数据。
   */
  @Get()
  @ApiOperation({ summary: '内置模型供应商模板（管理员）' })
  @ApiOkResponse({ type: ModelProviderTemplateResponseDto, isArray: true })
  list() {
    return this.service.listTemplates();
  }
}

@ApiTags('管理-模型供应商连接')
@ApiBearerAuth()
@Controller('admin/model-provider-connections')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminModelProviderConnectionController {
  constructor(
    private readonly service: ModelProviderConnectionService,
    private readonly modelPresetService: ModelPresetService,
  ) {}

  /**
   * 列出供应商连接
   * @returns 返回连接、子模型和引用计数
   * @description 用于供应商卡片与连接详情的单次加载。
   */
  @Get()
  @ApiOperation({ summary: '供应商连接列表（管理员）' })
  @ApiOkResponse({ type: ModelProviderConnectionResponseDto, isArray: true })
  list() {
    return this.service.list();
  }

  /**
   * 查询供应商连接
   * @param id 连接数据库 ID
   * @returns 返回连接、子模型和引用计数
   * @description 不返回 API Key 密文或明文。
   */
  @Get(':id')
  @ApiOperation({ summary: '供应商连接详情（管理员）' })
  @ApiOkResponse({ type: ModelProviderConnectionResponseDto })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /**
   * 创建供应商连接及首批模型
   * @param dto 连接共享字段与至少一个模型
   * @returns 返回创建后的完整连接
   * @description 连接和模型在同一事务创建，随后由管理端显式发起连接探测。
   */
  @Post()
  @ApiOperation({ summary: '新建供应商连接及模型（管理员）' })
  @ApiOkResponse({ type: ModelProviderConnectionResponseDto })
  create(@Body() dto: CreateModelProviderConnectionDto) {
    return this.service.create(dto);
  }

  /**
   * 在连接下新增模型
   * @param id 连接数据库 ID
   * @param dto 模型级配置
   * @returns 返回创建后的模型预设
   * @description API Key 与 URL 继续复用所属连接，不在请求中重复提交。
   */
  @Post(':id/models')
  @ApiOperation({ summary: '在供应商连接下新增模型（管理员）' })
  @ApiOkResponse({ type: ModelPresetResponseDto })
  createModel(@Param('id') id: string, @Body() dto: CreateModelPresetDto) {
    return this.modelPresetService.create(id, dto);
  }

  /**
   * 更新供应商连接
   * @param id 连接数据库 ID
   * @param dto 连接显示名、URL、密钥或启用状态
   * @returns 返回更新后的完整连接
   * @description URL、密钥或重新启用会重置其下模型能力档位。
   */
  @Patch(':id')
  @ApiOperation({ summary: '更新供应商连接（管理员）' })
  @ApiOkResponse({ type: ModelProviderConnectionResponseDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateModelProviderConnectionDto,
  ) {
    return this.service.update(id, dto);
  }

  /**
   * 探测供应商连接
   * @param id 连接数据库 ID
   * @param dto 该连接下用于最小对话的模型 ID
   * @returns 返回连接可达状态
   * @description 不修改模型工具能力档位。
   */
  @Post(':id/probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '执行供应商连接最小探测（管理员）' })
  @ApiOkResponse({ type: ModelProviderConnectionProbeResultDto })
  probe(@Param('id') id: string, @Body() dto: ProbeModelProviderConnectionDto) {
    return this.service.probe(id, dto);
  }

  /**
   * 删除空供应商连接
   * @param id 连接数据库 ID
   * @returns 返回成功标识
   * @description 连接下仍有模型时明确拒绝，不执行级联删除。
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除空供应商连接（管理员）' })
  @ApiOkResponse({ type: EmptyResultDto })
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { success: true };
  }
}
