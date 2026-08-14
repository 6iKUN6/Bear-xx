import {
  agentAvatarSrc,
  agentInitial,
  findAgent,
  getUnassignedAssistantNotice,
  resolveOutgoingAgentId,
} from "./agent";

const cases: Array<[string, unknown, unknown]> = [
  ["中文名称取首字", agentInitial("办伴"), "办"],
  ["英文名称先去空格", agentInitial("  Sparrow"), "S"],
  ["空名称回退问号", agentInitial("   "), "?"],
  ["头像 URL 去空格", agentAvatarSrc("  https://example.com/avatar.png  "), "https://example.com/avatar.png"],
  ["null 头像回退为空", agentAvatarSrc(null), null],
  [
    "群聊 @ 默认智能体保留真实 id",
    resolveOutgoingAgentId("group", "default-agent-id"),
    "default-agent-id",
  ],
  [
    "群聊未 @ 保持自动路由",
    resolveOutgoingAgentId("group"),
    undefined,
  ],
  [
    "未指定单聊回退默认智能体",
    findAgent(
      [
        { id: "agent-a", name: "甲", isDefault: false },
        { id: "default-agent-id", name: "办伴", isDefault: true },
      ],
      null,
    )?.name,
    "办伴",
  ],
  [
    "单聊无身份错误显示默认助手",
    getUnassignedAssistantNotice("error", false, false, false, false),
    null,
  ],
  [
    "群聊未建任务的无身份错误显示发送失败",
    getUnassignedAssistantNotice("error", true, false, false, false),
    "failure",
  ],
  [
    "群聊路由中优先显示指派提示",
    getUnassignedAssistantNotice("streaming", true, false, true, false),
    "routing",
  ],
];

for (const [description, actual, expected] of cases) {
  if (actual !== expected) {
    throw new Error(`${description}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}
