import assert from "node:assert/strict";
import test from "node:test";
import * as creation from "../src/renderer/src/lib/creation.ts";
import harness from "./load-store.cjs";

function setup(initial: string | null = null) {
  let raw = initial;
  let quotaExceeded = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => raw,
      setItem: (_key: string, value: string) => {
        if (quotaExceeded) throw new Error("QuotaExceededError");
        raw = value;
      },
    },
  });
  const { useCreationStore: store } = harness.loadStore(
    "stores/creation-store.ts",
    { "@/lib/creation": creation },
  );
  return {
    store,
    getRaw: () => raw,
    failWrites: () => {
      quotaExceeded = true;
    },
  };
}

test("自动保存写入失败时保留编辑，显示未保存状态，并可导出当前数据", () => {
  const { store, getRaw, failWrites } = setup();
  store.getState().hydrate();
  const id = store.getState().create("本机作品", "小说", "简介");
  assert.equal(store.getState().flush(), true);
  const before = getRaw();
  failWrites();
  store.getState().update(id, { brief: "手动更新后的简介" });
  assert.equal(store.getState().flush(), false);
  assert.equal(store.getState().dirty, true);
  assert.match(store.getState().error, /保存到本机失败/);
  assert.equal(getRaw(), before);
  assert.equal(
    creation.parseProjects(
      creation.serializeProjects(store.getState().projects),
    )[0].brief,
    "手动更新后的简介",
  );
});

test("损坏的本地数据不被空项目或新建操作覆盖", () => {
  const { store, getRaw } = setup("无法解析的原始数据");
  store.getState().hydrate();
  assert.equal(store.getState().storageBlocked, true);
  assert.throws(
    () => store.getState().create("新作品", "小说", ""),
    /保留原数据/,
  );
  assert.equal(store.getState().flush(), false);
  assert.equal(getRaw(), "无法解析的原始数据");
});

test("项目建议按指定项目采用，切换活动项目不会写入其他作品", () => {
  const { store } = setup();
  store.getState().hydrate();
  const first = store.getState().create("第一部", "小说", "");
  const chapter = store.getState().projects[0].chapters[0];
  const second = store.getState().create("第二部", "小说", "");
  store.getState().setProposal("first:user", {
    target: { chapterId: chapter.id, before: "", start: 0, end: 0 },
    content: "第一部的正文",
  });
  store.getState().adopt(first, "first:user");
  assert.equal(store.getState().activeProjectId, second);
  assert.equal(
    store
      .getState()
      .projects.find(
        (project: creation.CreationProject) => project.id === first,
      ).chapters[0].content,
    "第一部的正文",
  );
  assert.equal(
    store
      .getState()
      .projects.find(
        (project: creation.CreationProject) => project.id === second,
      ).chapters[0].content,
    "",
  );
  assert.equal(store.getState().flush(), true);
});

test("本机项目按账号保存助手会话，重开会话不影响其他账号关联", () => {
  const { store } = setup();
  store.getState().hydrate();
  const id = store.getState().create("作品", "小说", "");
  store.getState().bindConversation(id, "user-a", "chat-a");
  store.getState().bindConversation(id, "user-b", "chat-b");
  store.getState().bindConversation(id, "user-a", null);
  assert.deepEqual(store.getState().projects[0].conversations, {
    "user-b": "chat-b",
  });
  assert.equal(store.getState().flush(), true);
});
