/* eslint
  @typescript-eslint/no-unsafe-assignment: "off",
  @typescript-eslint/no-unsafe-member-access: "off",
  @typescript-eslint/no-unsafe-return: "off",
  @typescript-eslint/no-unsafe-call: "off",
  @typescript-eslint/no-unsafe-argument: "off",
  @typescript-eslint/no-floating-promises: "off",
  @typescript-eslint/no-unused-vars: "off",
  prettier/prettier: "off"
*/
import {
  MultiServerMCPClient,
  type ClientConfig,
} from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';

export const MCDONALDS_MCP_SERVER_NAME = 'mcdonalds';
export const MCDONALDS_MCP_URL = 'https://mcp.mcd.cn/mcp-servers/mcd-mcp';
const DEFAULT_MCDONALDS_MCP_TIMEOUT_MS = 30_000;

/**
 * 麦当劳 MCP 接入资料备注
 *
 * 公开入口：
 * - MCP 平台：https://open.mcd.cn/mcp
 * - MCP 文档入口：https://open.mcd.cn/mcp/doc
 * - MCP Server Base URL：https://mcp.mcd.cn
 * - MCP Server Endpoint：https://mcp.mcd.cn/mcp-servers/mcd-mcp
 *
 * 协议与鉴权：
 * - Transport：Streamable HTTP
 * - Header：Authorization: Bearer <TOKEN>
 * - Token：用户登录麦当劳 MCP 平台后自行激活获取；只在本服务端绑定请求内提交并加密保存，不能写入代码或暴露给前端
 * - 适用区域：中国大陆地区服务，不含港澳台
 *
 * 推荐点餐链路：
 * 1. 外送或团餐：delivery-query-addresses 查询用户配送地址，并从返回结果取得 storeCode、beCode、addressId
 * 2. 到店取餐：query-nearby-stores 按位置查询附近门店，并从返回结果取得 storeCode、beCode、takeWayCode
 * 3. query-meals：根据 storeCode、beCode 查询门店菜单
 * 4. query-meal-detail：根据 storeCode、beCode、code 查询餐品详情；部分促销或限时商品可能查不到，可退回使用 query-meals
 * 5. query-store-coupons：根据 storeCode 查询门店可用优惠券
 * 6. calculate-price：下单前按完整 JSON 参数计算价格和优惠
 * 7. create-order：确认价格后用同一组核心参数创建订单
 * 8. query-order：按 orderId 查询订单状态
 *
 * 工具与常用参数（公开资料整理，不同公开资料对 v1.0.3 工具集描述略有差异，真实 schema 以后续 MCP tools/list 返回结果为准）：
 * - query-nearby-stores：公开资料未列出完整字段；用于按位置查询附近门店，也可用于收藏门店查询
 * - delivery-query-addresses：无公开必填参数说明，用于查询用户配送地址列表
 * - delivery-create-address：公开资料未列出完整字段；第三方客户端示例为 mls|group、城市、联系人、电话、地址、门牌、性别
 * - query-meals：storeCode、beCode
 * - query-meal-detail：storeCode、beCode、code
 * - calculate-price：storeCode、beCode、addressId、items；第三方客户端示例支持 orderType、takeWayCode；items 为 [{ productCode, quantity }]
 * - create-order：storeCode、beCode、addressId、items；第三方客户端示例支持 orderType、takeWayCode；items 为 [{ productCode, quantity }]
 * - available-coupons：无公开必填参数说明，用于查询可领取优惠券
 * - auto-bind-coupons：无公开必填参数说明，用于自动领取所有可用优惠券
 * - query-my-coupons：无公开必填参数说明，用于查询卡包优惠券
 * - query-store-coupons：storeCode；部分客户端示例会额外携带 beCode
 * - query-my-account：无公开必填参数说明，用于查询积分账户
 * - mall-points-products：无公开必填参数说明，用于查询可兑换餐品券列表
 * - mall-product-detail：spuId
 * - mall-create-order：skuId
 * - query-order：orderId，公开资料提示为 34 位订单号
 * - campaign-calendar：无公开必填参数说明，用于查询当月营销活动日历
 * - list-nutrition-foods：无公开必填参数说明，用于查询餐品营养成分
 * - now-time-info：无公开必填参数说明，用于获取服务端当前时间
 *
 * 注意：
 * - calculate-price 与 create-order 必须传完整 JSON，字段名使用 items，不要改成 productList 或 products
 * - storeCode、beCode 必须来自 delivery-query-addresses 或 query-nearby-stores 的返回结果，不要自行生成
 * - 外送 orderType 通常为 2，需要 addressId；到店取餐 orderType 通常为 1，需要 takeWayCode
 * - create-order 返回的 payH5Url 公开资料提示可能是扫码支付页，生产接入前需要前后端确认支付跳转和用户确认策略
 * - 当前文件只封装 MCP client，不在模块初始化阶段主动连接，也不把工具注入 agent
 */
export interface McDonaldsMcpOptions {
  url?: string;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  prefixToolNameWithServerName?: boolean;
  additionalToolNamePrefix?: string;
  onConnectionError?: 'throw' | 'ignore';
}

export interface McDonaldsMcpToolBundle {
  client: MultiServerMCPClient;
  tools: DynamicStructuredTool[];
}

/**
 * 从运行时工具名中读取麦当劳 MCP 原始工具名
 * @param runtimeToolName LangChain adapter 加前缀后的运行时工具名
 * @param additionalToolNamePrefix 可选的额外工具名前缀
 * @returns 返回 MCP tools/list 原始工具名；不属于麦当劳 server 时返回 undefined
 * @description adapter 开启 prefixToolNameWithServerName 后会生成
 * `mcdonalds__<原始工具名>`；配置额外前缀时会变成
 * `<额外前缀>__mcdonalds__<原始工具名>`。白名单与审计必须基于原始工具名，
 * 不能把运行时前缀当作 MCP 协议名称。
 */
export function getMcDonaldsMcpToolName(
  runtimeToolName: string,
  additionalToolNamePrefix = '',
): string | undefined {
  const prefix = additionalToolNamePrefix
    ? `${additionalToolNamePrefix}__${MCDONALDS_MCP_SERVER_NAME}__`
    : `${MCDONALDS_MCP_SERVER_NAME}__`;

  if (!runtimeToolName.startsWith(prefix)) {
    return undefined;
  }

  const toolName = runtimeToolName.slice(prefix.length);
  return toolName || undefined;
}

/**
 * 创建麦当劳 MCP 客户端配置
 * @param options 麦当劳 MCP 连接配置
 * @returns 返回 MultiServerMCPClient 可消费的配置对象
 * @description 只负责封装麦当劳 MCP server 的连接参数，不主动初始化连接，也不接入 agent 工具链。
 */
export function createMcDonaldsMcpClientConfig(
  options: McDonaldsMcpOptions = {},
): ClientConfig {
  const url = options.url ?? MCDONALDS_MCP_URL;
  const token = options.token;
  const headers = buildMcDonaldsMcpHeaders(token, options.headers);

  return {
    throwOnLoadError: true,
    prefixToolNameWithServerName: options.prefixToolNameWithServerName ?? true,
    additionalToolNamePrefix: options.additionalToolNamePrefix ?? '',
    useStandardContentBlocks: true,
    onConnectionError: options.onConnectionError ?? 'throw',
    mcpServers: {
      [MCDONALDS_MCP_SERVER_NAME]: {
        transport: 'http',
        url,
        headers,
        automaticSSEFallback: true,
        defaultToolTimeout:
          options.timeoutMs ?? DEFAULT_MCDONALDS_MCP_TIMEOUT_MS,
      },
    },
  };
}

/**
 * 创建麦当劳 MCP 客户端
 * @param options 麦当劳 MCP 连接配置
 * @returns 返回 MultiServerMCPClient 实例
 * @description 创建但不主动连接 MCP server，后续调用 getTools 或 initializeConnections 时才会建立连接。
 */
export function createMcDonaldsMcpClient(
  options: McDonaldsMcpOptions = {},
): MultiServerMCPClient {
  const config = createMcDonaldsMcpClientConfig(options);

  return new MultiServerMCPClient(config);
}

/**
 * 加载麦当劳 MCP 工具
 * @param options 麦当劳 MCP 连接配置
 * @returns 返回 MCP 客户端和 LangChain 工具列表
 * @description 供后续 agent 工具注入时调用。当前文件只提供封装能力，不在模块初始化阶段自动连接。
 */
export async function loadMcDonaldsMcpTools(
  options: McDonaldsMcpOptions = {},
): Promise<McDonaldsMcpToolBundle> {
  const client = createMcDonaldsMcpClient(options);

  const tools = await client.getTools(MCDONALDS_MCP_SERVER_NAME);
  return { client, tools };
}

/**
 * 构建麦当劳 MCP 请求头
 * @param token MCP 鉴权 token
 * @param headers 额外请求头
 * @returns 返回合并后的请求头；没有请求头时返回 undefined
 * @description 优先保留调用方显式传入的 headers，并在未提供 Authorization 时使用 token 生成 Bearer 鉴权头。
 */
function buildMcDonaldsMcpHeaders(
  token: string | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const mergedHeaders = { ...(headers ?? {}) };

  if (token && !mergedHeaders.Authorization) {
    mergedHeaders.Authorization = `Bearer ${token}`;
  }

  return Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
}
