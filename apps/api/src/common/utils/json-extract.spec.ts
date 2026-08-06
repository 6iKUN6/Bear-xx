import { extractJsonText, parseJsonFromText } from './json-extract';

describe('json-extract', () => {
  it('纯 JSON 原样提取', () => {
    expect(parseJsonFromText('{"agentId":"a1"}')).toEqual({ agentId: 'a1' });
  });

  it('嵌套对象不被截断（旧非贪婪正则会在内层 } 处断开）', () => {
    const raw = '{"agentId":"a1","meta":{"score":0.9},"reason":"最合适"}';
    expect(parseJsonFromText(raw)).toEqual({
      agentId: 'a1',
      meta: { score: 0.9 },
      reason: '最合适',
    });
  });

  it('剥离 ``` / ```json 代码块', () => {
    expect(parseJsonFromText('```json\n{"mode":"react"}\n```')).toEqual({
      mode: 'react',
    });
    expect(parseJsonFromText('```\n{"mode":"direct"}\n```')).toEqual({
      mode: 'direct',
    });
  });

  it('容忍 JSON 前后的解释性杂文', () => {
    const raw = '好的，我的判断是：\n{"mode":"plan_execute"}\n以上。';
    expect(parseJsonFromText(raw)).toEqual({ mode: 'plan_execute' });
  });

  it('支持顶层数组（planner 允许裸数组步骤）', () => {
    expect(parseJsonFromText('[{"goal":"查天气"}]')).toEqual([
      { goal: '查天气' },
    ]);
  });

  it('空输入 / 无 JSON / 非法 JSON 一律返回 undefined', () => {
    expect(extractJsonText('')).toBeUndefined();
    expect(extractJsonText('没有任何结构化内容')).toBeUndefined();
    expect(parseJsonFromText('{"agentId":}')).toBeUndefined();
  });

  it('只有开括号没有闭括号时返回 undefined', () => {
    expect(extractJsonText('{"agentId":"a1"')).toBeUndefined();
  });
});
