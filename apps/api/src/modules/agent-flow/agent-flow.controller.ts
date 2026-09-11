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
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AgentFlowService } from './agent-flow.service';
import { AgentFlowVersionService } from './agent-flow-version.service';
import { CreateAgentFlowDto } from './dto/create-agent-flow.dto';
import {
  AgentFlowDetailResponseDto,
  AgentFlowResponseDto,
  AgentFlowTemplateResponseDto,
  AgentFlowValidationResponseDto,
  AgentFlowVersionResponseDto,
  AgentFlowVersionUpgradeResponseDto,
  AgentFlowDefinitionInspectionResponseDto,
} from './dto/agent-flow-response.dto';
import { EmptyResultDto } from '../../common/dto/empty-result.dto';
import { FlowTemplateRegistry } from './runtime/flow-template.registry';
import { ImportAgentFlowDto } from './dto/import-agent-flow.dto';
import { RollbackAgentFlowDto } from './dto/rollback-agent-flow.dto';
import { UpdateAgentFlowVersionDto } from './dto/update-agent-flow-version.dto';
import { UpdateAgentFlowDto } from './dto/update-agent-flow.dto';
import { ValidateAgentFlowDefinitionDto } from './dto/validate-agent-flow-definition.dto';
import { UserRole } from '@prisma/client';

/**
 * AgentFlow 管理端控制器
 * @description 暴露 Flow 草稿、版本、导入导出、发布和回滚的控制面 API；所有端点仅管理员可访问，不承担任何模型或工具执行。
 */
@ApiTags('管理-AgentFlow')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class AgentFlowController {
  constructor(
    private readonly flowService: AgentFlowService,
    private readonly versionService: AgentFlowVersionService,
    private readonly templateRegistry: FlowTemplateRegistry,
  ) {}

  /**
   * 创建 Flow 与首个草稿版本
   * @param dto 包含完整 FlowDefinition 的创建请求
   * @param actorId 当前管理员用户ID
   * @returns 返回新建 Flow 与 version 1 DRAFT
   * @description 创建接口只接受标准 FlowDefinition JSON，服务端会执行结构校验并在事务内写入版本和审计记录。
   */
  @Post('agent-flows')
  @ApiOperation({ summary: '创建 Flow 与首个草稿版本（管理员）' })
  @ApiOkResponse({ type: AgentFlowResponseDto })
  create(@Body() dto: CreateAgentFlowDto, @CurrentUser('id') actorId: string) {
    return this.flowService.create(dto.definition, actorId);
  }

  /**
   * 获取 Flow 列表
   * @returns 返回每个 Flow 及其当前发布版本摘要
   * @description 不返回全部版本、审批、审计或任务数据，供管理端流列表页使用。
   */
  @Get('agent-flows')
  @ApiOperation({ summary: '获取 Flow 列表（管理员）' })
  @ApiOkResponse({ type: AgentFlowResponseDto, isArray: true })
  list() {
    return this.flowService.list();
  }

  /**
   * 列出可作为新建起点的内置 Flow 模板
   * @returns 返回 Direct、ReAct、Plan Execute 与 Hybrid 的完整 Definition
   * @description 每次重新构造模板副本，管理端修改返回值不会污染后续请求；模板只表达结构与预算，模型统一为 `agent-default`。
   */
  @Get('agent-flow-templates')
  @ApiOperation({ summary: '获取内置 Flow 模板（管理员）' })
  @ApiOkResponse({ type: AgentFlowTemplateResponseDto, isArray: true })
  listTemplates(): AgentFlowTemplateResponseDto[] {
    return this.templateRegistry.list().map((preset) => {
      const definition = this.templateRegistry.get(preset);
      return {
        preset,
        name: definition.name,
        description: definition.description ?? '',
        definition,
      };
    });
  }

  /**
   * 获取一个 Flow 的详情与版本历史
   * @param flowId 逻辑 Flow ID
   * @returns 返回 Flow、当前发布版本和全部版本
   * @description 仅限管理端查看，返回的是版本化 JSON 工件而非运行中的任务快照。
   */
  @Get('agent-flows/:flowId')
  @ApiOperation({ summary: '获取 Flow 详情与版本历史（管理员）' })
  @ApiOkResponse({ type: AgentFlowDetailResponseDto })
  get(@Param('flowId') flowId: string) {
    return this.flowService.get(flowId);
  }

  /**
   * 更新 Flow 基本信息
   * @param flowId 逻辑 Flow ID
   * @param dto 新名称与可选描述
   * @param actorId 当前管理员用户ID
   * @returns 返回更新后的 Flow 基本信息
   * @description 同步更新最高版本号的 DRAFT 顶层名称和描述；已发布与已归档版本保持不可变。
   */
  @Patch('agent-flows/:flowId')
  @ApiOperation({ summary: '更新 Flow 名称与描述（管理员）' })
  @ApiOkResponse({ type: AgentFlowResponseDto })
  updateMetadata(
    @Param('flowId') flowId: string,
    @Body() dto: UpdateAgentFlowDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.flowService.updateMetadata(flowId, dto, actorId);
  }

  /**
   * 覆盖一个草稿版本
   * @param versionId 待编辑的 FlowVersion ID
   * @param dto 包含完整替换 JSON 的请求
   * @param actorId 当前管理员用户ID
   * @returns 返回更新后的 DRAFT 版本
   * @description 已发布和归档版本不可编辑；服务端不会接受局部 JSON patch，避免图工件处于半更新状态。
   */
  @Put('agent-flow-versions/:versionId')
  @ApiOperation({ summary: '覆盖草稿版本的 FlowDefinition（管理员）' })
  @ApiOkResponse({ type: AgentFlowVersionResponseDto })
  updateDraft(
    @Param('versionId') versionId: string,
    @Body() dto: UpdateAgentFlowVersionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.versionService.updateDraft(versionId, dto.definition, actorId);
  }

  /**
   * 校验管理端当前画布中的未保存 Definition
   * @param dto 包含当前完整 FlowDefinition 的请求
   * @returns 返回结构、图规则与运行时能力闭集的校验结果
   * @description 该端点不创建或更新版本，不写审计和 digest，供画布防抖自动检查当前草稿。
   */
  @Post('agent-flows/validate-definition')
  @ApiOperation({ summary: '校验未保存的 FlowDefinition（管理员）' })
  @ApiOkResponse({ type: AgentFlowValidationResponseDto })
  validateDefinition(@Body() dto: ValidateAgentFlowDefinitionDto) {
    return this.versionService.validateDefinition(dto.definition);
  }

  /**
   * 预检待导入 Definition 的版本状态与升级结果
   * @param dto 包含尚未写入的 Definition JSON
   * @returns 返回 current、upgradeable、invalid 或 unsupported 状态
   */
  @Post('agent-flows/inspect-definition')
  @ApiOperation({ summary: '预检并规范化 FlowDefinition（管理员）' })
  @ApiOkResponse({ type: AgentFlowDefinitionInspectionResponseDto })
  inspectDefinition(@Body() dto: ValidateAgentFlowDefinitionDto) {
    return this.versionService.inspectDefinition(dto.definition);
  }

  /**
   * 校验指定版本
   * @param versionId 待校验的 FlowVersion ID
   * @returns 返回结构校验错误或布局无关 digest
   * @description 同时校验 FlowDefinition 的结构、预算以及当前模型、工具组、技能闭集；用户级凭据仅在任务创建期校验。
   */
  @Post('agent-flow-versions/:versionId/validate')
  @ApiOperation({ summary: '校验 FlowDefinition 结构（管理员）' })
  @ApiOkResponse({ type: AgentFlowValidationResponseDto })
  validate(@Param('versionId') versionId: string) {
    return this.versionService.validate(versionId);
  }

  /**
   * 发布草稿版本
   * @param versionId 待发布的 FlowVersion ID
   * @param actorId 当前管理员用户ID
   * @returns 返回已发布的不可变版本
   * @description 发布会原子地归档旧发布版本、锁定 digest 并切换 Flow 当前发布指针。
   */
  @Post('agent-flow-versions/:versionId/publish')
  @ApiOperation({ summary: '发布草稿版本（管理员）' })
  @ApiOkResponse({ type: AgentFlowVersionResponseDto })
  publish(
    @Param('versionId') versionId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.versionService.publish(versionId, actorId);
  }

  /**
   * 将可升级的历史版本物化为当前版本草稿
   * @param versionId 历史 FlowVersion ID
   * @param actorId 当前管理员用户 ID
   * @returns 返回新草稿和迁移摘要
   * @description 不改写源工件、发布指针或 Agent 绑定；已有草稿时明确拒绝。
   */
  @Post('agent-flow-versions/:versionId/upgrade-to-current')
  @ApiOperation({ summary: '升级历史 FlowDefinition 为当前草稿（管理员）' })
  @ApiOkResponse({ type: AgentFlowVersionUpgradeResponseDto })
  upgradeToCurrentDraft(
    @Param('versionId') versionId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.versionService.upgradeToCurrentDraft(versionId, actorId);
  }

  /**
   * 导出单个版本的 FlowDefinition
   * @param versionId 待导出的 FlowVersion ID
   * @returns 返回不含数据库元数据的标准 JSON 工件
   * @description 导出内容可直接作为导入接口的 definition 输入，不包含 ID、审计、任务或密钥数据。
   */
  @Get('agent-flow-versions/:versionId/export')
  @ApiOperation({ summary: '导出 FlowDefinition JSON（管理员）' })
  @ApiOkResponse({ description: '标准 FlowDefinition JSON 工件' })
  exportDefinition(@Param('versionId') versionId: string) {
    return this.versionService.exportDefinition(versionId);
  }

  /**
   * 将 JSON 工件导入为新草稿版本
   * @param flowId 导入目标的逻辑 Flow ID
   * @param dto 仅包含 JSON 文件内容的请求
   * @param actorId 当前管理员用户ID
   * @returns 返回递增创建的新 DRAFT 版本
   * @description 导入不会覆盖现有版本，即使语义 digest 相同也始终形成独立草稿，待管理员显式发布。
   */
  @Post('agent-flows/:flowId/import')
  @ApiOperation({ summary: '导入 JSON 为新草稿版本（管理员）' })
  @ApiOkResponse({ type: AgentFlowVersionResponseDto })
  importDefinition(
    @Param('flowId') flowId: string,
    @Body() dto: ImportAgentFlowDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.flowService.importDefinition(flowId, dto.definition, actorId);
  }

  /**
   * 回滚到一个历史发布版本
   * @param flowId 逻辑 Flow ID
   * @param dto 指定历史版本的回滚请求
   * @param actorId 当前管理员用户ID
   * @returns 返回恢复为当前发布版本的历史工件
   * @description 回滚只切换版本状态和发布指针，不修改历史 Definition 或 digest。
   */
  @Post('agent-flows/:flowId/rollback')
  @ApiOperation({ summary: '回滚到历史发布版本（管理员）' })
  @ApiOkResponse({ type: AgentFlowVersionResponseDto })
  rollback(
    @Param('flowId') flowId: string,
    @Body() dto: RollbackAgentFlowDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.flowService.rollback(flowId, dto.versionId, actorId);
  }

  /**
   * 删除一个从未被任务运行过的 Flow
   * @param flowId 逻辑 Flow ID
   * @returns 返回删除结果
   * @description 跑过任务或仍被智能体绑定的 Flow 会被拒绝并给出原因；不做软删除，也不静默解绑。
   */
  @Delete('agent-flows/:flowId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除未运行过的 Flow（管理员）' })
  @ApiOkResponse({ type: EmptyResultDto })
  async remove(@Param('flowId') flowId: string) {
    await this.flowService.remove(flowId);
    return { success: true };
  }
}
