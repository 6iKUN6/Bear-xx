const assert = require("node:assert/strict");
const test = require("node:test");
const { loadStore } = require("./load-store.cjs");

function setup() {
  const streams = [];
  const canceled = [];
  let remote = Promise.resolve([]);
  let cancelResult = Promise.resolve({ status: "canceled" });
  const Event = {
    MessageDelta: "delta",
    MessageDone: "done",
    ConversationTitleUpdated: "title",
    ApprovalRequired: "approval",
    ApprovalResolved: "resolved",
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
      cancelStreamTask: (id) => {
        canceled.push(id);
        return cancelResult;
      },
    },
    "@/api/stream": {
      streamChatMessage: stream,
      streamApproval: (id, decision, cursor, handlers) =>
        stream({ id, decision, cursor }, handlers),
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
  };
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

test("等待审批保持活动任务，并支持同一任务多轮审批", () => {
  const { store, streams, Event } = setup();
  const id = store.getState().send("操作");
  streams[0].handlers.onEvent(
    {
      type: Event.ApprovalRequired,
      taskId: "task",
      payload: { toolName: "test", approvalId: "a" },
    },
    "1-0",
  );
  streams[0].handlers.onDone();
  assert.equal(store.getState().sending, true);
  store.getState().submitApproval(id, { decision: "approve" });
  assert.equal(streams[1].body.cursor, "1-0");
  streams[1].handlers.onEvent(
    {
      type: Event.ApprovalRequired,
      taskId: "task",
      payload: { toolName: "test2", approvalId: "b" },
    },
    "2-0",
  );
  streams[1].handlers.onDone();
  assert.equal(store.getState().approvalSubmitting, false);
  assert.equal(store.getState().sending, true);
  store.getState().submitApproval(id, { decision: "approve" });
  streams[2].handlers.onEvent(
    { type: Event.MessageDone, payload: { content: "已完成" } },
    "3-0",
  );
  streams[2].handlers.onDone();
  assert.equal(store.getState().sending, false);
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
