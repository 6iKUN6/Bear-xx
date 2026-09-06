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
  ModelPresetProbeResultDto,
  ModelPresetReferencesResponseDto,
  ModelPresetResponseDto,
  UpdateModelPresetDto,
} from './dto/model-preset.dto';
import { ModelPresetService } from './model-preset.service';

@ApiTags('管理-模型预设')
@ApiBearerAuth()
@Controller('admin/model-presets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminModelPresetController {
  constructor(private readonly service: ModelPresetService) {}

  /**
   * 列出模型预设
   * @returns 返回包含所属连接摘要的全部模型预设
   * @description 供管理端模型视图与排障使用，不返回共享连接密钥。
   */
  @Get()
  @ApiOperation({ summary: '模型预设列表（管理员）' })
  @ApiOkResponse({ type: ModelPresetResponseDto, isArray: true })
  list() {
    return this.service.list();
  }

  /**
   * 查询模型预设引用
   * @param id 模型预设数据库 ID
   * @returns 返回 Agent 与 Flow 引用位置
   * @description 与删除护栏复用同一引用判据。
   */
  @Get(':id/references')
  @ApiOperation({ summary: '查询模型预设引用（管理员）' })
  @ApiOkResponse({ type: ModelPresetReferencesResponseDto })
  references(@Param('id') id: string) {
    return this.service.references(id);
  }

  /**
   * 查询模型预设详情
   * @param id 模型预设数据库 ID
   * @returns 返回模型与所属连接摘要
   * @description presetId 与连接归属均为只读字段。
   */
  @Get(':id')
  @ApiOperation({ summary: '模型预设详情（管理员）' })
  @ApiOkResponse({ type: ModelPresetResponseDto })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /**
   * 更新模型预设
   * @param id 模型预设数据库 ID
   * @param dto 模型级配置
   * @returns 返回更新后的模型预设
   * @description 修改模型或协议会重置当前模型能力档位。
   */
  @Patch(':id')
  @ApiOperation({ summary: '更新模型预设（管理员）' })
  @ApiOkResponse({ type: ModelPresetResponseDto })
  update(@Param('id') id: string, @Body() dto: UpdateModelPresetDto) {
    return this.service.update(id, dto);
  }

  /**
   * 探测模型完整能力
   * @param id 模型预设数据库 ID
   * @returns 返回基础对话与工具往返结论
   * @description 使用所属连接密钥并写回模型能力档位。
   */
  @Post(':id/probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '探测模型完整能力并写回档位（管理员）' })
  @ApiOkResponse({ type: ModelPresetProbeResultDto })
  probe(@Param('id') id: string) {
    return this.service.probeExisting(id);
  }

  /**
   * 删除无引用模型预设
   * @param id 模型预设数据库 ID
   * @returns 返回成功标识
   * @description 系统默认模型或仍被 Agent、Flow、运行中任务引用的模型会被拒绝。
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除模型预设（管理员）' })
  @ApiOkResponse({ type: EmptyResultDto })
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { success: true };
  }
}
