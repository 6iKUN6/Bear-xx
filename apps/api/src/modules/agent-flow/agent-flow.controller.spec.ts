import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { validateFlowDefinition } from './definition/flow-definition.validator';
import { AgentFlowController } from './agent-flow.controller';
import { AgentFlowService } from './agent-flow.service';
import { AgentFlowVersionService } from './agent-flow-version.service';
import { FlowTemplateRegistry } from './runtime/flow-template.registry';

describe('AgentFlowController', () => {
  let controller: AgentFlowController;
  let create: jest.Mock<Promise<Record<string, unknown>>, [unknown, string]>;
  let updateMetadata: jest.Mock<
    Promise<Record<string, unknown>>,
    [string, unknown, string]
  >;
  let remove: jest.Mock<Promise<void>, [string]>;
  let validateDefinition: jest.Mock<Record<string, unknown>, [unknown]>;

  beforeEach(async () => {
    create = jest.fn<Promise<Record<string, unknown>>, [unknown, string]>();
    updateMetadata = jest.fn<
      Promise<Record<string, unknown>>,
      [string, unknown, string]
    >();
    remove = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    validateDefinition = jest.fn<Record<string, unknown>, [unknown]>();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentFlowController],
      providers: [
        {
          provide: AgentFlowService,
          useValue: { create, updateMetadata, remove },
        },
        {
          provide: AgentFlowVersionService,
          useValue: { validateDefinition },
        },
        // 用真实注册表：模板端点的价值就在于返回能通过校验器的 Definition
        FlowTemplateRegistry,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({})
      .overrideGuard(RolesGuard)
      .useValue({})
      .compile();

    controller = module.get(AgentFlowController);
  });

  it('将创建请求交给服务层，并以 ADMIN、JWT 和 RolesGuard 保护控制面', async () => {
    create.mockResolvedValue({ id: 'flow-1' });
    const definition = { schemaVersion: 1, kind: 'agent-flow' };

    await controller.create({ definition }, 'admin-1');

    expect(create).toHaveBeenCalledWith(definition, 'admin-1');
    expect(Reflect.getMetadata(ROLES_KEY, AgentFlowController)).toEqual([
      'ADMIN',
      'SUPER_ADMIN',
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentFlowController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
  });

  it('模板端点返回全部内置预设，且每份 Definition 都能通过校验器', () => {
    const templates = controller.listTemplates();

    expect(templates.map((template) => template.preset)).toEqual([
      'blank',
      'direct',
      'react',
      'plan_execute',
      'hybrid',
    ]);
    // 模板是「新建 Flow」的起点；返回一份校验不通过的 JSON 等于把用户送进死路
    for (const template of templates) {
      expect(validateFlowDefinition(template.definition).success).toBe(true);
      expect(template.name).not.toBe('');
    }
  });

  it('模板每次返回独立副本，调用方修改不污染下一次请求', () => {
    const first = controller.listTemplates()[0];
    (first.definition as { name: string }).name = '被改过了';

    expect(controller.listTemplates()[0].name).not.toBe('被改过了');
  });

  it('将 Flow 基本信息更新交给服务层', async () => {
    updateMetadata.mockResolvedValue({
      id: 'flow-1',
      name: '新名称',
      description: '新描述',
    });

    await expect(
      controller.updateMetadata(
        'flow-1',
        { name: '新名称', description: '新描述' },
        'admin-1',
      ),
    ).resolves.toMatchObject({ name: '新名称', description: '新描述' });
    expect(updateMetadata).toHaveBeenCalledWith(
      'flow-1',
      { name: '新名称', description: '新描述' },
      'admin-1',
    );
  });

  it('校验未保存 Definition 时直接使用请求工件且不要求版本 ID', () => {
    const definition = { schemaVersion: 7, kind: 'agent-flow' };
    validateDefinition.mockReturnValue({ valid: false, errors: [] });

    expect(controller.validateDefinition({ definition })).toEqual({
      valid: false,
      errors: [],
    });
    expect(validateDefinition).toHaveBeenCalledWith(definition);
  });

  it('删除端点把 flowId 交给服务层并返回成功信封', async () => {
    await expect(controller.remove('flow-1')).resolves.toEqual({
      success: true,
    });
    expect(remove).toHaveBeenCalledWith('flow-1');
  });
});
