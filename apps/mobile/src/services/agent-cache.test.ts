import {
  AGENT_CACHE_VERSION,
  createAgentCache,
  readAgentCache,
  type CacheableAgent,
} from "./agent-cache";

const agent: CacheableAgent = {
  id: "agent-1",
  name: "测试智能体",
  description: "",
  avatar: null,
  toolGroups: [],
  enabled: true,
  visible: true,
  minimumMembershipTier: "FREE",
  canUse: true,
  accessReason: null,
  requiredTier: null,
  isDefault: true,
};

const validCache = createAgentCache("user-1", [agent]);

const cases: Array<[string, unknown, string, (typeof agent)[] | null]> = [
  ["接受同一用户的完整缓存", validCache, "user-1", [agent]],
  ["拒绝升级前的数组缓存", [agent], "user-1", null],
  ["拒绝其他用户的资格缓存", validCache, "user-2", null],
  [
    "拒绝缺少资格字段的旧智能体",
    {
      version: AGENT_CACHE_VERSION,
      userId: "user-1",
      agents: [{ id: "agent-1", name: "旧智能体" }],
    },
    "user-1",
    null,
  ],
];

for (const [description, raw, userId, expected] of cases) {
  const actual = readAgentCache(raw, userId);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${description}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    );
  }
}
