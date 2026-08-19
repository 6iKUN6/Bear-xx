import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AgentFlowController } from './agent-flow.controller';
import { AgentFlowService } from './agent-flow.service';
import { AgentFlowVersionService } from './agent-flow-version.service';

describe('AgentFlowController', () => {
  let controller: AgentFlowController;
  let create: jest.Mock<Promise<Record<string, unknown>>, [unknown, string]>;

  beforeEach(async () => {
    create = jest.fn<Promise<Record<string, unknown>>, [unknown, string]>();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentFlowController],
      providers: [
        {
          provide: AgentFlowService,
          useValue: { create },
        },
        {
          provide: AgentFlowVersionService,
          useValue: {},
        },
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
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentFlowController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
  });
});
