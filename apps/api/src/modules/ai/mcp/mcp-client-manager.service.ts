import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import {
  getMcDonaldsMcpToolName,
  loadMcDonaldsMcpTools,
  MCDONALDS_MCP_SERVER_NAME,
  type McDonaldsMcpOptions,
  type McDonaldsMcpToolBundle,
} from './McDonalds.mcp';

/** 当前已接入的 MCP server 标识；新增 server 时在此扩展闭集。 */
export type McpServerId = typeof MCDONALDS_MCP_SERVER_NAME;

/** MCP 工具的来源信息，写入 capability 与 conversation trace。 */
export interface McpToolMetadata {
  mcpServer: McpServerId;
  mcpTool: string;
}

/**
 * 麦当劳 MCP 审核工具白名单
 * @description 只暴露点餐闭环中低风险查询、计价、下单与订单查询工具。
 * 地址创建、领券、积分商城下单等会改动用户外部账户的工具，必须单独评审后才可加入。
 */
export const MCDONALDS_MCP_ALLOWED_TOOL_NAMES = [
  'delivery-query-addresses',
  'query-nearby-stores',
  'query-meals',
  'query-meal-detail',
  'query-store-coupons',
  'calculate-price',
  'query-order',
  'create-order',
] as const;

interface McpCredentialRuntime {
  client: McDonaldsMcpToolBundle['client'];
  tools: DynamicStructuredTool[];
  metadataByRuntimeToolName: Map<string, McpToolMetadata>;
}

/**
 * MCP 客户端管理器
 * @description 以用户凭据 ID 为缓存键管理 Streamable HTTP client。client 只持有已通过白名单审核的工具，
 * 不保存 Token、不承担用户权限判断；凭据服务在每次装配工具时提供短时解密 Token。
 */
@Injectable()
export class McpClientManager implements OnModuleDestroy {
  private readonly logger = new Logger(McpClientManager.name);
  private readonly credentialRuntimes = new Map<string, McpCredentialRuntime>();
  private readonly loadingCredentials = new Map<
    string,
    Promise<McpCredentialRuntime>
  >();
  private readonly evictedCredentialIds = new Set<string>();
  private readonly closedClients = new WeakSet<object>();

  constructor(private readonly configService: ConfigService) {}

  /**
   * 保持 MCP 模块初始化契约
   * @returns 返回已完成的 Promise
   * @description 用户级 Token 模式没有进程级全局 client；工具 schema 在用户绑定校验和实际请求时加载。
   */
  ensureInitialized(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 获取指定用户凭据的审核工具
   * @param credentialId 本地凭据ID
   * @param token 本次请求范围内的解密 Token
   * @returns 返回已审核且按凭据缓存的工具列表
   * @description 相同 credentialId 并发加载会复用同一 Promise；缓存键从不使用 Token，避免敏感值进入进程状态索引或日志。
   */
  async getMcDonaldsTools(
    credentialId: string,
    token: string,
  ): Promise<DynamicStructuredTool[]> {
    const runtime = await this.getCredentialRuntime(credentialId, token);
    return [...runtime.tools];
  }

  /**
   * 按原始 MCP 工具名获取指定用户凭据的审核工具
   * @param credentialId 本地凭据ID
   * @param token 本次请求范围内的解密 Token
   * @param mcpTool MCP tools/list 中的原始工具名
   * @returns 返回已审核的运行时工具
   * @description 订单刷新只调用此方法，不会重新按名称猜测或暴露未审核工具。
   */
  async getMcDonaldsToolByName(
    credentialId: string,
    token: string,
    mcpTool: string,
  ): Promise<DynamicStructuredTool> {
    const runtime = await this.getCredentialRuntime(credentialId, token);
    const runtimeToolName = [
      ...runtime.metadataByRuntimeToolName.entries(),
    ].find(([, metadata]) => metadata.mcpTool === mcpTool)?.[0];
    const tool = runtime.tools.find((item) => item.name === runtimeToolName);
    if (!tool) {
      throw new Error(`麦当劳 MCP 未注册审核工具：${mcpTool}`);
    }
    return tool;
  }

  /**
   * 获取运行时工具对应的 MCP 来源
   * @param server MCP server 标识
   * @param runtimeToolName 注入 Agent 的工具名
   * @returns 返回 MCP server 与原始工具名；非审核工具返回 undefined
   * @description 元数据依据稳定的运行时命名与审核白名单推导，不依赖某个用户 client 是否已在缓存中。
   */
  getToolMetadata(
    server: McpServerId,
    runtimeToolName: string,
  ): McpToolMetadata | undefined {
    if (server !== MCDONALDS_MCP_SERVER_NAME) {
      return undefined;
    }
    const mcpTool = getMcDonaldsMcpToolName(
      runtimeToolName,
      this.additionalToolNamePrefix,
    );
    if (
      !mcpTool ||
      !MCDONALDS_MCP_ALLOWED_TOOL_NAMES.includes(mcpTool as never)
    ) {
      return undefined;
    }
    return { mcpServer: server, mcpTool };
  }

  /**
   * 验证用户提交的麦当劳 MCP Token
   * @param token 用户本次绑定请求中的 Token
   * @returns 无返回值
   * @description 仅执行 tools/list 与白名单完整性校验，结束后立即关闭临时 client，不将 Token 或临时 client 进入运行时缓存。
   */
  async verifyMcDonaldsToken(token: string): Promise<void> {
    let bundle: McDonaldsMcpToolBundle | undefined;
    try {
      bundle = await this.loadMcDonaldsTools(this.buildOptions(token));
      this.filterMcDonaldsTools(bundle.tools);
    } finally {
      if (bundle) {
        await this.closeClient(bundle.client, '绑定校验');
      }
    }
  }

  /**
   * 清理一个或多个用户凭据关联的 MCP client
   * @param credentialIds 需要驱逐的本地凭据ID列表
   * @returns 无返回值
   * @description 换绑、解绑、凭据失效时调用。关闭失败只记录安全摘要，不能阻止凭据状态变更。
   */
  async evictCredentialClients(credentialIds: string[]): Promise<void> {
    await Promise.all(
      [...new Set(credentialIds)].map(async (credentialId) => {
        this.evictedCredentialIds.add(credentialId);
        let loadingRuntime: McpCredentialRuntime | undefined;
        const loading = this.loadingCredentials.get(credentialId);
        if (loading) {
          try {
            loadingRuntime = await loading;
            await this.closeClient(loadingRuntime.client, credentialId);
          } catch {
            // 加载失败时 client 已由加载分支负责清理。
          }
        }

        const runtime = this.credentialRuntimes.get(credentialId);
        this.loadingCredentials.delete(credentialId);
        this.credentialRuntimes.delete(credentialId);
        if (runtime && runtime !== loadingRuntime) {
          await this.closeClient(runtime.client, credentialId);
        }
      }),
    );
  }

  /**
   * 关闭所有已缓存的 MCP client
   * @returns 无返回值
   * @description 应用退出时释放 adapter 创建的底层连接和 transport 资源。
   */
  async onModuleDestroy(): Promise<void> {
    await this.evictCredentialClients([...this.credentialRuntimes.keys()]);
  }

  /**
   * 按凭据取得或加载 MCP 运行时缓存
   * @param credentialId 本地凭据ID
   * @param token 本次调用范围内的解密 Token
   * @returns 返回工具与来源元数据缓存
   * @description 白名单校验失败不会留下缓存；实际运行时只会复用此前对同一凭据完成的审核结果。
   */
  private async getCredentialRuntime(
    credentialId: string,
    token: string,
  ): Promise<McpCredentialRuntime> {
    const cached = this.credentialRuntimes.get(credentialId);
    if (cached) {
      return cached;
    }
    const loading = this.loadingCredentials.get(credentialId);
    if (loading) {
      return loading;
    }

    this.evictedCredentialIds.delete(credentialId);
    const promise = this.loadCredentialRuntime(credentialId, token);
    this.loadingCredentials.set(credentialId, promise);
    try {
      const runtime = await promise;
      if (this.evictedCredentialIds.has(credentialId)) {
        await this.closeClient(runtime.client, credentialId);
        throw new Error('凭据连接已撤销');
      }
      this.credentialRuntimes.set(credentialId, runtime);
      return runtime;
    } finally {
      this.loadingCredentials.delete(credentialId);
      this.evictedCredentialIds.delete(credentialId);
    }
  }

  /**
   * 建立并审核一个凭据对应的 MCP client
   * @param credentialId 本地凭据ID，仅用于安全日志和缓存归属
   * @param token 本次调用范围内的解密 Token
   * @returns 返回审核后的工具运行时
   * @description adapter 工具名和 schema 必须经过完整白名单校验；失败时立即关闭已创建的 client。
   */
  private async loadCredentialRuntime(
    credentialId: string,
    token: string,
  ): Promise<McpCredentialRuntime> {
    let bundle: McDonaldsMcpToolBundle | undefined;
    try {
      bundle = await this.loadMcDonaldsTools(this.buildOptions(token));
      const { tools, metadataByRuntimeToolName } = this.filterMcDonaldsTools(
        bundle.tools,
      );
      return {
        client: bundle.client,
        tools,
        metadataByRuntimeToolName,
      };
    } catch (error) {
      if (bundle) {
        await this.closeClient(bundle.client, credentialId);
      }
      throw error;
    }
  }

  /**
   * 构建麦当劳 MCP adapter 连接参数
   * @param token 本次调用范围内的解密 Token
   * @returns 返回不含全局 Token 的连接配置
   * @description URL 和命名前缀可以由环境配置调整，身份凭据只能来自用户级安全存储。
   */
  private buildOptions(token: string): McDonaldsMcpOptions {
    return {
      token,
      url:
        this.configService.get<string>('MCDONALDS_MCP_URL')?.trim() ||
        undefined,
      additionalToolNamePrefix: this.additionalToolNamePrefix,
    };
  }

  /**
   * 筛选麦当劳审核工具
   * @param loadedTools MCP adapter 加载的全部工具
   * @returns 返回审核工具与其运行时工具名到 MCP 来源的映射
   * @description 审核以 MCP 原始工具名为依据；远端新增工具不会自动进入模型上下文，远端删改已审核工具会明确失败。
   */
  private filterMcDonaldsTools(loadedTools: DynamicStructuredTool[]): {
    tools: DynamicStructuredTool[];
    metadataByRuntimeToolName: Map<string, McpToolMetadata>;
  } {
    const allowed = new Set<string>(MCDONALDS_MCP_ALLOWED_TOOL_NAMES);
    const toolByMcpName = new Map<string, DynamicStructuredTool>();
    for (const loadedTool of loadedTools) {
      const mcpTool = getMcDonaldsMcpToolName(
        loadedTool.name,
        this.additionalToolNamePrefix,
      );
      if (mcpTool && allowed.has(mcpTool)) {
        toolByMcpName.set(mcpTool, loadedTool);
      }
    }

    const missingTools = MCDONALDS_MCP_ALLOWED_TOOL_NAMES.filter(
      (name) => !toolByMcpName.has(name),
    );
    if (missingTools.length > 0) {
      throw new Error(`MCP 工具清单缺少已审核工具：${missingTools.join(', ')}`);
    }

    const tools = MCDONALDS_MCP_ALLOWED_TOOL_NAMES.map((name) =>
      toolByMcpName.get(name)!,
    );
    return {
      tools,
      metadataByRuntimeToolName: new Map(
        tools.map((tool) => [
          tool.name,
          {
            mcpServer: MCDONALDS_MCP_SERVER_NAME,
            mcpTool: getMcDonaldsMcpToolName(
              tool.name,
              this.additionalToolNamePrefix,
            )!,
          },
        ]),
      ),
    };
  }

  /**
   * 加载麦当劳 MCP 工具
   * @param options 麦当劳 MCP 连接参数
   * @returns 返回 adapter client 与其 tools/list 结果
   * @description 提供受保护覆写点，单元测试可用本地 fixture 验证白名单、缓存和关闭语义，不请求真实外部服务。
   */
  protected loadMcDonaldsTools(
    options: McDonaldsMcpOptions,
  ): Promise<McDonaldsMcpToolBundle> {
    return loadMcDonaldsMcpTools(options);
  }

  /**
   * 关闭一个 MCP client
   * @param client adapter 创建的 MCP client
   * @param target 不含敏感信息的凭据或操作标识
   * @returns 无返回值
   * @description 关闭异常只记录安全文字，绝不写入 Token、请求头或远端响应体。
   */
  private async closeClient(
    client: McDonaldsMcpToolBundle['client'],
    target: string,
  ): Promise<void> {
    if (this.closedClients.has(client)) {
      return;
    }
    this.closedClients.add(client);
    try {
      await client.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`关闭麦当劳 MCP client（${target}）失败：${message}`);
    }
  }

  private get additionalToolNamePrefix(): string {
    return (
      this.configService.get<string>('MCDONALDS_MCP_TOOL_PREFIX')?.trim() ?? ''
    );
  }
}
