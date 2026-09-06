export const AGENT_CACHE_VERSION = 1;

type MembershipTier = "FREE" | "PLUS" | "PRO";
type PaidMembershipTier = Exclude<MembershipTier, "FREE">;
type AgentAccessReason =
  "DISABLED" | "MEMBERSHIP_EXPIRED" | "MEMBERSHIP_REQUIRED" | null;

export interface CacheableAgent {
  id: string;
  name: string;
  description: string;
  avatar: string | null;
  toolGroups: string[];
  enabled: boolean;
  visible: boolean;
  minimumMembershipTier: MembershipTier;
  canUse: boolean;
  accessReason: AgentAccessReason;
  requiredTier: PaidMembershipTier | null;
  isDefault: boolean;
}

interface AgentCacheEnvelope<TAgent extends CacheableAgent> {
  version: typeof AGENT_CACHE_VERSION;
  userId: string;
  agents: TAgent[];
}

/**
 * 创建当前用户的智能体缓存信封
 * @param userId 当前登录用户ID
 * @param agents 已通过接口契约校验的智能体列表
 * @returns 返回带缓存版本和用户归属的智能体列表信封
 * @description 用户资格投影不能跨账号复用；版本用于主动淘汰旧契约缓存。
 */
export function createAgentCache<TAgent extends CacheableAgent>(
  userId: string,
  agents: TAgent[],
): AgentCacheEnvelope<TAgent> {
  return { version: AGENT_CACHE_VERSION, userId, agents };
}

/**
 * 读取当前用户可安全复用的智能体缓存
 * @param raw 本地存储中的未知缓存值
 * @param userId 当前登录用户ID
 * @returns 缓存版本、用户归属和每项字段都合法时返回智能体列表，否则返回 null
 * @description 拒绝升级前的裸数组、其他用户的资格投影及缺少会员字段的旧数据，避免渲染 undefined。
 */
export function readAgentCache<TAgent extends CacheableAgent>(
  raw: unknown,
  userId: string,
): TAgent[] | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== AGENT_CACHE_VERSION || raw.userId !== userId) {
    return null;
  }
  if (!Array.isArray(raw.agents) || !raw.agents.every(isCacheableAgent)) {
    return null;
  }
  return raw.agents as TAgent[];
}

/**
 * 校验接口返回的智能体列表是否包含完整访问投影
 * @param value 待检查的接口响应
 * @returns 全部列表项满足当前客户端契约时返回 true
 * @description 网络响应也做运行时校验，避免错误网关或旧服务响应覆盖一份已知有效的缓存。
 */
export function isAgentList(value: unknown): value is CacheableAgent[] {
  return Array.isArray(value) && value.every(isCacheableAgent);
}

/**
 * 校验单个智能体是否满足当前缓存契约
 * @param value 待检查的智能体投影
 * @returns 基础字段和访问结论均完整且相互一致时返回 true
 * @description 可用智能体不得携带拒绝原因；会员拒绝必须携带 PLUS 或 PRO 门槛。
 */
function isCacheableAgent(value: unknown): value is CacheableAgent {
  if (!isRecord(value)) return false;
  const reason = value.accessReason;
  const requiredTier = value.requiredTier;
  const fieldsValid =
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    (typeof value.avatar === "string" || value.avatar === null) &&
    Array.isArray(value.toolGroups) &&
    value.toolGroups.every((group) => typeof group === "string") &&
    typeof value.enabled === "boolean" &&
    typeof value.visible === "boolean" &&
    isMembershipTier(value.minimumMembershipTier) &&
    typeof value.canUse === "boolean" &&
    (reason === null ||
      reason === "DISABLED" ||
      reason === "MEMBERSHIP_EXPIRED" ||
      reason === "MEMBERSHIP_REQUIRED") &&
    (requiredTier === null ||
      requiredTier === "PLUS" ||
      requiredTier === "PRO") &&
    typeof value.isDefault === "boolean";
  if (!fieldsValid) return false;
  if (value.canUse) return reason === null && requiredTier === null;
  if (reason === "DISABLED") return requiredTier === null;
  return (
    (reason === "MEMBERSHIP_EXPIRED" || reason === "MEMBERSHIP_REQUIRED") &&
    (requiredTier === "PLUS" || requiredTier === "PRO")
  );
}

/**
 * 将未知值收窄为固定会员等级
 * @param value 待检查的未知值
 * @returns 值属于 FREE、PLUS、PRO 闭集时返回 true
 * @description 缓存读取不依赖 TypeScript 静态类型，必须在运行时拒绝陌生等级。
 */
function isMembershipTier(value: unknown): value is MembershipTier {
  return value === "FREE" || value === "PLUS" || value === "PRO";
}

/**
 * 将未知值收窄为可按字段读取的记录
 * @param value 待检查的未知值
 * @returns 值为非空对象时返回 true
 * @description 作为缓存信封与列表项运行时校验的基础守卫。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
