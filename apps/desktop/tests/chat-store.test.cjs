const assert = require("node:assert/strict");
const test = require("node:test");
const { loadStore } = require("./load-store.cjs");

class StreamRequestError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

function setup() {
  const streams = [];
  const canceled = [];
  let remote = Promise.resolve([]);
  let cancelResult = Promise.resolve({ status: "canceled" });
  const pages = [];
  const pageRequests = [];
  let taskStatus = Promise.resolve({ canResume: false, status: "completed" });
  const Event = {
    MessageDelta: "delta",
    MessageDone: "done",
    ConversationTitleUpdated: "title",
    FlowWaitingHuman: "waiting",
    FlowRunResumed: "resumed",
    TaskCompleted: "completed",
    TaskCanceled: "canceled",
    TaskError: "error",
  };
  function stream(body, handlers) {
    const call = { body, handlers, aborted: false };
    streams.push(call);
    return {
      abort() {
        call.aborted = true;
      },
    };
  }
  const { useChatStore: store } = loadStore("stores/chat-store.ts", {
    "@/api/endpoints": {
      getConversations: () => remote,
      getConversationMessages: (id, before) => {
        pageRequests.push({ id, before });
        return pages.shift() ?? Promise.resolve({ messages: [], hasMore: false });
      },
      getStreamTaskStatus: () => taskStatus,
      cancelStreamTask: (id) => {
        canceled.push(id);
        return cancelResult;
      },
    },
    "@/api/stream": {
      StreamRequestError,
      resumeTaskStream: (id, cursor, handlers) =>
        stream({ kind: "resume", id, cursor }, handlers),
      streamChatMessage: stream,
      streamApproval: (id, approvalId, decision, cursor, handlers) =>
        stream({ kind: "tool", id, approvalId, decision, cursor }, handlers),
      streamPlanReview: (id, approvalId, decision, cursor, handlers) =>
        stream(
          { kind: "plan-review", id, approvalId, decision, cursor },
          handlers,
        ),
    },
    "@litter-bear/types/protocol": {
      StreamTaskEventType: Event,
      STREAM_TASK_EVENT_LABELS: { error: "生成失败" },
      TASK_ERROR_CATEGORY_LABELS: { network: "网络异常" },
    },
    "@litter-bear/chat-core": {
      buildStreamFeedbackFromTrace: () => undefined,
      toMessageStreamFeedback: () => undefined,
    },
  });
  return {
    store,
    streams,
    canceled,
    Event,
    setRemote(value) {
      remote = value;
    },
    setCancel(value) {
      cancelResult = value;
    },
    pushPage(value) {
      pages.push(Promise.resolve(value));
    },
    pageRequests,
    setTaskStatus(value) {
      taskStatus = Promise.resolve(value);
    },
  };
}

function serverMessage(id, overrides = {}) {
  return {
    id,
    role: "assistant",
    content: id,
    status: "done",
    createdAt: 1,
    activeTaskId: null,
    ...overrides,
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("项目助手独立绑定会话，不切走普通对话；完成回调只返回最终正文", () => {
  const { store, streams, Event } = setup();
  store.getState().setActive("normal");
  const ids = [],
    completed = [];
  store.getState().send("创作请求", {
    conversationId: null,
    onConversationId: (id) => ids.push(id),
    onComplete: (message) => completed.push(message),
  });
  const h = streams[0].handlers;
  h.onEvent(
    {
      type: Event.MessageDelta,
      taskId: "task",
      conversationId: "project-chat",
      payload: { delta: "片段" },
    },
    "1-0",
  );
  assert.equal(store.getState().activeId, "normal");
  assert.equal(ids[1], "project-chat");
  h.onEvent(
    { type: Event.MessageDone, payload: { content: "完整正文" } },
    "2-0",
  );
  assert.equal(store.getState().sending, true);
  h.onDone();
  assert.equal(store.getState().sending, false);
  assert.equal(completed[0].content, "完整正文");
});

test("重复 SSE 游标不重复追加正文，普通对话草稿随服务端 ID 迁移", () => {
  const { store, streams, Event } = setup();
  store.getState().send("消息");
  store.getState().setDraft(store.getState().activeId, "还没发出的下一条");
  const event = {
    type: Event.MessageDelta,
    conversationId: "server",
    payload: { delta: "文字" },
  };
  streams[0].handlers.onEvent(event, "1-0");
  streams[0].handlers.onEvent(event, "1-0");
  assert.equal(store.getState().drafts.server, "还没发出的下一条");
  assert.equal(store.getState().conversations[0].messages[1].content, "文字");
});

function toolWait(approvalId, toolName) {
  return {
    approvalId,
    nodeKey: "agent",
    traceKey: `approval:${approvalId}`,
    expiresAt: "2026-10-21T00:00:00.000Z",
    approval: {
      kind: "tool",
      requests: [{ toolName, index: 0 }],
      allowedDecisions: ["approve", "reject"],
    },
  };
}

test("等待审批保持活动任务，并支持同一任务多轮审批", () => {
  const { store, streams, Event } = setup();
  const id = store.getState().send("操作");
  streams[0].handlers.onEvent(
    { type: Event.FlowWaitingHuman, taskId: "task", payload: toolWait("a", "test") },
    "1-0",
  );
  streams[0].handlers.onDone();
  assert.equal(store.getState().sending, true);
  store.getState().submitApproval(id, { decision: "approve" });
  assert.equal(streams[0].aborted, true);
  assert.equal(streams[1].body.kind, "tool");
  assert.equal(streams[1].body.approvalId, "a");
  assert.equal(streams[1].body.cursor, "1-0");
  assert.equal(
    store.getState().conversations[0].messages[1].resolvedApproval.decision,
    "approve",
  );
  streams[1].handlers.onEvent(
    { type: Event.FlowRunResumed, taskId: "task", payload: { reason: "approval" } },
    "2-0",
  );
  streams[1].handlers.onEvent(
    { type: Event.FlowWaitingHuman, taskId: "task", payload: toolWait("b", "test2") },
    "3-0",
  );
  streams[1].handlers.onDone();
  assert.equal(store.getState().approvalSubmitting, false);
  assert.equal(store.getState().sending, true);
  store.getState().submitApproval(id, { decision: "approve" });
  assert.equal(streams[2].body.approvalId, "b");
  streams[2].handlers.onEvent(
    { type: Event.MessageDone, payload: { content: "已完成" } },
    "4-0",
  );
  streams[2].handlers.onDone();
  assert.equal(store.getState().sending, false);
});

test("计划审批走 plan-review 入口并携带 approvalId，入口与审批类型不符时不提交", () => {
  const { store, streams, Event } = setup();
  const id = store.getState().send("规划一次旅行");
  streams[0].handlers.onEvent(
    {
      type: Event.FlowWaitingHuman,
      taskId: "task",
      payload: {
        approvalId: "plan-1",
        nodeKey: "review",
        traceKey: "approval:plan-1",
        expiresAt: "2026-10-21T00:00:00.000Z",
        approval: {
          kind: "plan-review",
          steps: [{ id: "s1", goal: "查天气" }],
          revision: 0,
          allowedDecisions: ["approve", "edit", "reject_replan", "reject_terminate"],
        },
      },
    },
    "1-0",
  );
  store.getState().submitApproval(id, { decision: "approve" });
  assert.equal(streams.length, 1, "工具审批入口不能提交计划审批");
  store.getState().submitPlanReview(id, {
    decision: "edit",
    editedSteps: [{ goal: "查天气" }, { goal: "订酒店" }],
  });
  assert.equal(streams[1].body.kind, "plan-review");
  assert.equal(streams[1].body.approvalId, "plan-1");
  assert.equal(streams[1].body.cursor, "1-0");
  const message = store.getState().conversations[0].messages[1];
  assert.equal(message.pendingApproval, undefined);
  assert.equal(message.resolvedApproval.kind, "plan-review");
  assert.equal(message.resolvedApproval.decision, "edit");
});

test("停止等待服务器取消成功，再关闭流；取消失败保留任务", async () => {
  const { store, streams, canceled, Event, setCancel } = setup();
  store.getState().send("生成");
  streams[0].handlers.onEvent({
    type: Event.MessageDelta,
    taskId: "task",
    payload: { delta: "正文" },
  });
  setCancel(Promise.reject(new Error("网络失败")));
  await store.getState().cancel();
  assert.equal(streams[0].aborted, false);
  assert.equal(store.getState().sending, true);
  assert.equal(store.getState().taskError, "网络失败");
  const pending = deferred();
  setCancel(pending.promise);
  const cancel = store.getState().cancel();
  assert.equal(streams[0].aborted, false);
  pending.resolve({ status: "canceled" });
  await cancel;
  assert.deepEqual(canceled, ["task", "task"]);
  assert.equal(streams[0].aborted, true);
  assert.equal(store.getState().conversations[0].messages[1].canceled, true);
  assert.equal(store.getState().sending, false);
});

test("退出账号会中止连接，丢弃迟到的流事件与会话响应", async () => {
  const { store, streams, Event, setRemote } = setup();
  const pending = deferred();
  setRemote(pending.promise);
  const loading = store.getState().loadConversations();
  store.getState().send("第一位用户");
  store.getState().reset();
  assert.equal(streams[0].aborted, true);
  streams[0].handlers.onEvent({
    type: Event.MessageDelta,
    payload: { delta: "旧数据" },
  });
  pending.resolve([{ id: "old", messages: [] }]);
  await loading;
  assert.deepEqual(store.getState().conversations, []);
});

test("流意外结束时保留部分正文并标明错误，不伪装生成成功", () => {
  const { store, streams, Event } = setup();
  store.getState().send("消息");
  streams[0].handlers.onEvent({
    type: Event.MessageDelta,
    payload: { delta: "部分正文" },
  });
  streams[0].handlers.onDone();
  const message = store.getState().conversations[0].messages[1];
  assert.equal(message.content, "部分正文");
  assert.equal(message.status, "error");
  assert.match(message.errorMessage, /未收到完成确认/);
});

test("断线后用同一任务从断点续接，收到新帧即清除重连状态", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, streams, Event } = setup();
  store.getState().send("长任务");
  streams[0].handlers.onEvent(
    { type: Event.MessageDelta, taskId: "task", payload: { delta: "前半" } },
    "1-0",
  );
  streams[0].handlers.onError(new StreamRequestError("network", true));
  assert.equal(store.getState().reconnecting, true);
  assert.equal(store.getState().sending, true);
  assert.equal(streams.length, 1, "退避期间不立即重连");
  t.mock.timers.tick(1000);
  assert.deepEqual(streams[1].body, { kind: "resume", id: "task", cursor: "1-0" });
  // 重放已收到的帧不会重复拼接正文
  streams[1].handlers.onEvent(
    { type: Event.MessageDelta, taskId: "task", payload: { delta: "前半" } },
    "1-0",
  );
  streams[1].handlers.onEvent(
    { type: Event.MessageDelta, taskId: "task", payload: { delta: "后半" } },
    "2-0",
  );
  assert.equal(store.getState().reconnecting, false);
  streams[1].handlers.onEvent(
    { type: Event.MessageDone, payload: { content: "前半后半" } },
    "3-0",
  );
  streams[1].handlers.onDone();
  const message = store.getState().conversations[0].messages[1];
  assert.equal(message.content, "前半后半");
  assert.equal(message.status, "done");
  assert.equal(store.getState().sending, false);
});

test("连接提前关闭也会续接；续接次数用尽后才标记错误", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, streams, Event } = setup();
  store.getState().send("消息");
  streams[0].handlers.onEvent(
    { type: Event.MessageDelta, taskId: "task", payload: { delta: "部分" } },
    "1-0",
  );
  streams[0].handlers.onDone();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    t.mock.timers.tick(1000 * 2 ** attempt);
    assert.equal(streams.length, attempt + 2);
    streams[attempt + 1].handlers.onDone();
  }
  const message = store.getState().conversations[0].messages[1];
  assert.equal(message.status, "error");
  assert.equal(message.content, "部分");
  assert.equal(store.getState().reconnecting, false);
  assert.equal(store.getState().sending, false);
});

test("不可重试的失败与尚未创建任务的失败直接报错，不尝试续接", () => {
  const { store, streams, Event } = setup();
  store.getState().send("第一条");
  streams[0].handlers.onEvent(
    { type: Event.MessageDelta, taskId: "task", payload: { delta: "x" } },
    "1-0",
  );
  streams[0].handlers.onError(new StreamRequestError("登录已过期", false));
  assert.equal(store.getState().conversations[0].messages[1].status, "error");
  assert.equal(store.getState().reconnecting, false);

  store.getState().send("第二条");
  streams[1].handlers.onError(new StreamRequestError("network", true));
  assert.equal(streams.length, 2, "没有 taskId 时无法安全续接");
  assert.equal(store.getState().sending, false);
});

test("退避期间退出账号会取消待执行的续接", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, streams, Event } = setup();
  store.getState().send("消息");
  streams[0].handlers.onEvent(
    { type: Event.MessageDelta, taskId: "task", payload: { delta: "x" } },
    "1-0",
  );
  streams[0].handlers.onError(new StreamRequestError("network", true));
  store.getState().reset();
  t.mock.timers.tick(5000);
  assert.equal(streams.length, 1);
});

test("会话目录不带消息：沿用已加载的消息，进入会话再按页拉取", async () => {
  const { store, setRemote, pushPage, pageRequests } = setup();
  setRemote(Promise.resolve([{ id: "c1", title: "一", createdAt: 1, updatedAt: 2 }]));
  await store.getState().loadConversations();
  assert.deepEqual(store.getState().conversations[0].messages, []);

  pushPage({ messages: [serverMessage("m2"), serverMessage("m3")], hasMore: true });
  store.getState().setActive("c1");
  await settle();
  assert.deepEqual(pageRequests[0], { id: "c1", before: undefined });
  let conv = store.getState().conversations[0];
  assert.deepEqual(conv.messages.map((m) => m.id), ["m2", "m3"]);
  assert.equal(conv.hasMoreMessages, true);

  // 刷新目录不丢已加载的消息
  setRemote(Promise.resolve([{ id: "c1", title: "一（改名）", createdAt: 1, updatedAt: 3 }]));
  await store.getState().loadConversations();
  conv = store.getState().conversations[0];
  assert.equal(conv.title, "一（改名）");
  assert.equal(conv.messages.length, 2);

  pushPage({ messages: [serverMessage("m1"), serverMessage("m2")], hasMore: false });
  await store.getState().loadOlderMessages("c1");
  assert.deepEqual(pageRequests[1], { id: "c1", before: "m2" });
  conv = store.getState().conversations[0];
  assert.deepEqual(conv.messages.map((m) => m.id), ["m1", "m2", "m3"], "重叠的消息去重");
  assert.equal(conv.hasMoreMessages, false);
  await store.getState().loadOlderMessages("c1");
  assert.equal(pageRequests.length, 2, "没有更早消息时不再请求");
});

test("本机正在生成的会话不被服务端旧快照覆盖", async () => {
  const { store, streams, Event, setRemote, pushPage, pageRequests } = setup();
  setRemote(Promise.resolve([{ id: "c1", title: "一", createdAt: 1, updatedAt: 2 }]));
  await store.getState().loadConversations();
  pushPage({ messages: [], hasMore: false });
  store.getState().setActive("c1");
  await settle();
  store.getState().send("问题");
  streams[0].handlers.onEvent(
    { type: Event.MessageDelta, taskId: "task", conversationId: "c1", payload: { delta: "半截" } },
    "1-0",
  );
  await store.getState().loadMessages("c1");
  assert.equal(pageRequests.length, 1, "活动流期间不重新拉取");
  assert.equal(store.getState().conversations[0].messages[1].content, "半截");
});

test("进入会话时接回未结束的任务：从游标 0 重放并清空半截正文", async () => {
  const { store, streams, Event, setRemote, pushPage, setTaskStatus } = setup();
  setRemote(Promise.resolve([{ id: "c1", title: "一", createdAt: 1, updatedAt: 2 }]));
  await store.getState().loadConversations();
  pushPage({
    messages: [
      serverMessage("u1", { role: "user" }),
      serverMessage("a1", { status: "streaming", content: "半截", activeTaskId: "task-1" }),
    ],
    hasMore: false,
  });
  setTaskStatus({ canResume: true, status: "streaming", fullContent: "半截" });
  store.getState().setActive("c1");
  await settle();
  assert.deepEqual(streams[0].body, { kind: "resume", id: "task-1", cursor: "0" });
  assert.equal(store.getState().sending, true);
  let message = store.getState().conversations[0].messages[1];
  assert.equal(message.content, "");
  streams[0].handlers.onEvent(
    { type: Event.MessageDelta, taskId: "task-1", payload: { delta: "完整回答" } },
    "1-0",
  );
  streams[0].handlers.onEvent(
    { type: Event.MessageDone, payload: { content: "完整回答" } },
    "2-0",
  );
  streams[0].handlers.onDone();
  message = store.getState().conversations[0].messages[1];
  assert.equal(message.content, "完整回答");
  assert.equal(message.status, "done");
  assert.equal(store.getState().sending, false);
});

test("任务已结束时用终稿收敛，不再显示生成中", async () => {
  const { store, streams, setRemote, pushPage, setTaskStatus } = setup();
  setRemote(Promise.resolve([{ id: "c1", title: "一", createdAt: 1, updatedAt: 2 }]));
  await store.getState().loadConversations();
  pushPage({
    messages: [serverMessage("a1", { status: "streaming", content: "半", activeTaskId: "task-1" })],
    hasMore: false,
  });
  setTaskStatus({ canResume: false, status: "error", fullContent: "半截终稿" });
  store.getState().setActive("c1");
  await settle();
  assert.equal(streams.length, 0);
  const message = store.getState().conversations[0].messages[0];
  assert.equal(message.content, "半截终稿");
  assert.equal(message.status, "error");
  assert.equal(message.activeTaskId, null);
});

