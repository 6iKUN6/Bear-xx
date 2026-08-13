import {
  CapabilityRegistry,
  MCDONALDS_ORDER_TOOL_GROUP,
} from './capability.registry';

describe('CapabilityRegistry 用户级麦当劳工具组', () => {
  it('始终登记 mcd-order 组，但仅向锁定凭据的任务开放', () => {
    const registry = new CapabilityRegistry(
      {} as never,
      { get: jest.fn() } as never,
    );

    expect(registry.listToolGroups()).toContain(MCDONALDS_ORDER_TOOL_GROUP);
    expect(registry.canUseToolGroup(MCDONALDS_ORDER_TOOL_GROUP, 'user-1')).toBe(
      false,
    );
    expect(
      registry.canUseToolGroup(
        MCDONALDS_ORDER_TOOL_GROUP,
        'user-1',
        'credential-1',
      ),
    ).toBe(true);
  });

  it('用户级 create-order 维持人工审批与 MCP 来源标识', () => {
    const registry = new CapabilityRegistry(
      {} as never,
      { get: jest.fn() } as never,
    );

    expect(registry.requiresApproval('mcdonalds__create-order')).toBe(true);
    expect(registry.getToolMetadata('mcdonalds__create-order')).toEqual({
      mcpServer: 'mcdonalds',
      mcpTool: 'create-order',
    });
  });

  it('使用自定义 MCP 工具名前缀时仍能识别下单审批与来源', () => {
    const registry = new CapabilityRegistry(
      {} as never,
      { get: jest.fn().mockReturnValue('partner') } as never,
    );

    expect(registry.requiresApproval('partner__mcdonalds__create-order')).toBe(
      true,
    );
    expect(
      registry.getToolMetadata('partner__mcdonalds__create-order'),
    ).toEqual({
      mcpServer: 'mcdonalds',
      mcpTool: 'create-order',
    });
  });

  it('不会把未审核的同前缀工具标记为麦当劳 MCP 来源', () => {
    const registry = new CapabilityRegistry(
      {} as never,
      { get: jest.fn() } as never,
    );

    expect(registry.getToolMetadata('mcdonalds__unknown-tool')).toBeUndefined();
  });
});
