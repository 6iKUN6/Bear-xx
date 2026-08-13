import { ConfigService } from '@nestjs/config';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type {
  McDonaldsMcpOptions,
  McDonaldsMcpToolBundle,
} from './McDonalds.mcp';
import {
  McpClientManager,
  MCDONALDS_MCP_ALLOWED_TOOL_NAMES,
} from './mcp-client-manager.service';

class TestMcpClientManager extends McpClientManager {
  constructor(
    private readonly bundle: McDonaldsMcpToolBundle & { close: jest.Mock },
  ) {
    super(new ConfigService());
  }

  protected override loadMcDonaldsTools(
    _options: McDonaldsMcpOptions,
  ): Promise<McDonaldsMcpToolBundle> {
    return Promise.resolve(this.bundle);
  }
}

class DeferredMcpClientManager extends McpClientManager {
  constructor(private readonly load: Promise<McpToolBundleForTest>) {
    super(new ConfigService());
  }

  protected override loadMcDonaldsTools(
    _options: McDonaldsMcpOptions,
  ): Promise<McpToolBundleForTest> {
    return this.load;
  }
}

type McpToolBundleForTest = McDonaldsMcpToolBundle;

describe('McpClientManager 用户级凭据', () => {
  it('按 credentialId 缓存工具，并在驱逐后关闭 client', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const manager = new TestMcpClientManager({
      client: { close } as never,
      tools: MCDONALDS_MCP_ALLOWED_TOOL_NAMES.map((name) =>
        tool(() => 'ok', {
          name: `mcdonalds__${name}`,
          description: name,
          schema: z.object({}),
        }),
      ),
      close,
    });

    const first = await manager.getMcDonaldsTools('credential-1', 'token-1');
    const second = await manager.getMcDonaldsTools('credential-1', 'token-1');
    await manager.evictCredentialClients(['credential-1']);

    expect(first.map((item) => item.name)).toHaveLength(
      MCDONALDS_MCP_ALLOWED_TOOL_NAMES.length,
    );
    expect(second).toEqual(first);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('验证 Token 时不保留 client', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const manager = new TestMcpClientManager({
      client: { close } as never,
      tools: MCDONALDS_MCP_ALLOWED_TOOL_NAMES.map((name) =>
        tool(() => 'ok', {
          name: `mcdonalds__${name}`,
          description: name,
          schema: z.object({}),
        }),
      ),
      close,
    });

    await manager.verifyMcDonaldsToken('token-1');

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('驱逐加载中的凭据只关闭一次且不会重新写入缓存', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    let resolveBundle: (bundle: McpToolBundleForTest) => void;
    const loading = new Promise<McpToolBundleForTest>((resolve) => {
      resolveBundle = resolve;
    });
    const manager = new DeferredMcpClientManager(loading);
    const getTools = manager.getMcDonaldsTools('credential-1', 'token-1');
    const eviction = manager.evictCredentialClients(['credential-1']);

    resolveBundle!({
      client: { close } as never,
      tools: MCDONALDS_MCP_ALLOWED_TOOL_NAMES.map((name) =>
        tool(() => 'ok', {
          name: `mcdonalds__${name}`,
          description: name,
          schema: z.object({}),
        }),
      ),
    });

    await expect(getTools).rejects.toThrow('凭据连接已撤销');
    await eviction;
    expect(close).toHaveBeenCalledTimes(1);
  });
});
