import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const TAVILY_SEARCH_API_URL = 'https://api.tavily.com/search';
const SEARCH_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
const MAX_CONTENT_LENGTH = 500;

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: TavilySearchResult[];
  response_time?: number;
}

const webSearch = tool(
  async (input: {
    query: string;
    maxResults?: number;
    topic?: 'general' | 'news';
  }) => {
    const apiKey = process.env.TAVILY_API_KEY?.trim();
    if (!apiKey) {
      return '联网搜索不可用：服务端未配置 TAVILY_API_KEY。请提示用户联系管理员开启联网搜索能力。';
    }

    try {
      const query = normalizeQuery(input);
      const response = await fetchSearch(apiKey, query);
      return formatSearchResult(response, query.maxResults);
    } catch (error) {
      return `联网搜索失败：${
        error instanceof Error ? error.message : String(error)
      }。请提示用户稍后重试，或换一个更明确的查询关键词。`;
    }
  },
  {
    name: 'webSearch',
    description:
      '联网搜索实时信息。适合回答时事、新闻、最新数据、特定网站内容等需要联网获取的最新知识的问题；不要用于纯常识或可直接回答的问题。返回若干条带标题、链接和正文摘要的结果。',
    schema: z.object({
      query: z
        .string()
        .min(1)
        .describe('搜索关键词或问题，例如「2026 年杭州亚运会时间」'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS_LIMIT)
        .optional()
        .describe(
          `返回结果条数，默认 ${DEFAULT_MAX_RESULTS}，最大 ${MAX_RESULTS_LIMIT}`,
        ),
      topic: z
        .enum(['general', 'news'])
        .optional()
        .describe('搜索主题，general=通用，news=新闻时事，默认 general'),
    }),
  },
);

/**
 * 规范化搜索参数
 * @param input 工具调用输入
 * @returns 返回清洗后的搜索参数
 * @description 对查询词做去空白，对结果条数和主题做兜底，避免下游请求重复处理默认值。
 */
function normalizeQuery(input: {
  query: string;
  maxResults?: number;
  topic?: 'general' | 'news';
}) {
  return {
    query: input.query.trim(),
    maxResults: Math.min(
      input.maxResults ?? DEFAULT_MAX_RESULTS,
      MAX_RESULTS_LIMIT,
    ),
    topic: input.topic ?? 'general',
  };
}

/**
 * 调用 Tavily 搜索接口
 * @param apiKey Tavily API Key
 * @param query 规范化后的搜索参数
 * @returns 返回 Tavily 搜索结果
 * @description 使用 basic 深度（1 credit）并请求 LLM 生成的简答，统一处理 fetch、超时与非 2xx 响应。
 */
async function fetchSearch(
  apiKey: string,
  query: { query: string; maxResults: number; topic: 'general' | 'news' },
): Promise<TavilySearchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SEARCH_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(TAVILY_SEARCH_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: query.query,
        topic: query.topic,
        search_depth: 'basic',
        max_results: query.maxResults,
        include_answer: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('搜索服务鉴权失败，请检查 TAVILY_API_KEY 是否有效');
      }
      if (response.status === 429) {
        throw new Error('搜索服务已达免费额度上限，请稍后再试');
      }
      throw new Error(`搜索服务请求失败，状态码：${response.status}`);
    }

    return (await response.json()) as TavilySearchResponse;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('搜索服务请求超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 格式化搜索结果
 * @param response Tavily 搜索结果
 * @param maxResults 请求的结果条数
 * @returns 返回供大模型直接消费的中文搜索摘要
 * @description 将 LLM 简答与逐条结果（标题、链接、截断后的正文）拼成稳定中文文本，降低模型后处理难度。
 */
function formatSearchResult(
  response: TavilySearchResponse,
  maxResults: number,
): string {
  const results = (response.results ?? []).slice(0, maxResults);
  if (results.length === 0) {
    return `未搜索到与「${response.query ?? ''}」相关的结果，请换一个查询关键词。`;
  }

  const lines: string[] = [];
  lines.push(`联网搜索结果（共 ${results.length} 条）：`);

  if (response.answer?.trim()) {
    lines.push(`概要：${response.answer.trim()}`);
  }

  results.forEach((result, index) => {
    const title = result.title?.trim() || '（无标题）';
    const parts = [`${index + 1}. ${title}`];
    if (result.url) {
      parts.push(`   链接：${result.url}`);
    }
    const content = truncateContent(result.content);
    if (content) {
      parts.push(`   摘要：${content}`);
    }
    lines.push(parts.join('\n'));
  });

  return lines.join('\n');
}

/**
 * 截断正文摘要
 * @param content 原始正文
 * @returns 截断到上限的正文；缺失时返回空串
 * @description 单条结果正文过长会挤占上下文，统一截断到固定长度并追加省略号。
 */
function truncateContent(content?: string): string {
  const text = content?.trim();
  if (!text) {
    return '';
  }
  return text.length > MAX_CONTENT_LENGTH
    ? `${text.slice(0, MAX_CONTENT_LENGTH)}...`
    : text;
}

export default webSearch;
