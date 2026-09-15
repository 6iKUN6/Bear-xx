import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProposal,
  buildCreationPrompt,
  createProject,
  parseProjects,
  projectText,
  serializeProjects,
  undoProposal,
  wordCount,
} from "../src/renderer/src/lib/creation.ts";

test("本机项目从空开始，完整备份能保留设定、正文与账号会话关联", () => {
  assert.deepEqual(parseProjects(null), []);
  const project = createProject("  测试作品  ", "小说", "故事简介");
  project.characters = "人物资料";
  project.conversations = { userA: "conversationA" };
  project.chapters[0].content = "第一段正文。\n第二段正文。";
  assert.equal(project.name, "测试作品");
  assert.deepEqual(parseProjects(serializeProjects([project])), [project]);
});

test("损坏、未知版本、字段类型错误与重复 ID 不会伪装成空项目", () => {
  for (const raw of [
    "{",
    "null",
    '{"version":2,"projects":[]}',
    '{"version":1,"projects":[{}]}',
  ]) {
    assert.throws(() => parseProjects(raw));
  }
  const project = createProject("作品", "小说", "");
  assert.throws(() => parseProjects(serializeProjects([project, project])));
  assert.throws(() =>
    parseProjects(
      JSON.stringify({
        version: 1,
        projects: [{ ...project, conversations: { user: 123 } }],
      }),
    ),
  );
  project.chapters.push(project.chapters[0]);
  assert.throws(() => parseProjects(serializeProjects([project])));
});

test("采用选中片段只替换该范围，前后文保持完整", () => {
  const chapter = {
    id: "ch",
    title: "第一章",
    outline: "",
    content: "前文。原文。后文。",
  };
  const proposal = {
    target: { chapterId: "ch", before: chapter.content, start: 3, end: 6 },
    content: "修改后的片段。",
  };
  assert.equal(applyProposal(chapter, proposal), "前文。修改后的片段。后文。");
});

test("异步建议不能覆盖手动编辑、其他章节或失效选区", () => {
  const chapter = { id: "ch", title: "第一章", outline: "", content: "原文" };
  const proposal = {
    target: { chapterId: "ch", before: "原文", start: 0, end: 2 },
    content: "新正文",
  };
  assert.throws(
    () => applyProposal({ ...chapter, content: "用户后来改过" }, proposal),
    /已发生修改/,
  );
  assert.throws(() => applyProposal({ ...chapter, id: "other" }, proposal));
  assert.throws(() =>
    applyProposal(chapter, {
      ...proposal,
      target: { ...proposal.target, end: 999 },
    }),
  );
});

test("空章节可以采用全文，撤销恢复原文；后续手动编辑阻止撤销", () => {
  const chapter = { id: "ch", title: "第一章", outline: "", content: "" };
  const proposal = {
    target: { chapterId: "ch", before: "", start: 0, end: 0 },
    content: "新正文",
  };
  const content = applyProposal(chapter, proposal);
  const applied = { ...proposal, appliedContent: content };
  assert.equal(undoProposal({ ...chapter, content }, applied), "");
  assert.throws(
    () => undoProposal({ ...chapter, content: "已手动续写" }, applied),
    /又编辑/,
  );
  assert.throws(() => undoProposal(chapter, proposal));
});

test("助手使用当前项目与章节资料，讨论模式不要求正文替换", () => {
  const project = createProject("作品", "悬疑", "世界设定");
  const chapter = project.chapters[0];
  chapter.content = "章节文本";
  const prompt = buildCreationPrompt(
    project,
    chapter,
    "  帮我分析冲突  ",
    null,
  );
  assert.match(prompt, /世界设定/);
  assert.match(prompt, /章节文本/);
  assert.ok(prompt.endsWith("用户要求：帮我分析冲突"));
  assert.ok(!prompt.includes("本次输出将替换"));
});

test("长上下文显式拒绝发送，不静默截断创作资料", () => {
  const project = createProject("作品", "小说", "长".repeat(20000));
  assert.throws(
    () => buildCreationPrompt(project, project.chapters[0], "生成正文", null),
    /20,000/,
  );
});

test("文本导出包含章节顺序和真实正文，字数不计空白", () => {
  const project = createProject("作品", "小说", "");
  project.chapters[0].content = " 第一段 \n 第二段 ";
  assert.equal(wordCount(project.chapters[0].content), 6);
  assert.ok(projectText(project).startsWith("作品\n\n\n第 1 章\n\n"));
  assert.ok(projectText(project).includes(project.chapters[0].content));
});
