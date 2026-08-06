import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from './llm.service';
import type { LlmModelRegistryService } from './llm-model-registry.service';
import type { LlmChatModelFactory } from './providers/chat-model.factory';

/** 生图请求体（JSON 分支）关心的字段 */
type ImageRequestBody = {
  model?: string;
  prompt?: string;
  n?: number;
  size?: string;
  image?: string | string[];
};

/** Seedream 像素下限（2560x1440） */
const SEEDREAM_MIN_PIXELS = 3686400;

/** 把 "2048x2048" 解析成总像素 */
function pixelsOf(size: string): number {
  const [w, h] = size.split('x').map(Number);
  return w * h;
}

/** 从 fetch mock 的某次调用里取出 JSON body */
function parseJsonBody(call: unknown[]): ImageRequestBody {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as ImageRequestBody;
}

/**
 * 生图 provider 分派单测：只覆盖 IMAGE_GEN_* 配置驱动的端点/请求体构造，
 * 不触达真实网络（fetch 全 mock）。聊天相关依赖未在生图路径使用，传空 stub。
 */
describe('LlmService 生图 provider 分派', () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  /** 取第一次 fetch 调用的 [url, init]（类型收窄避免 any 下标） */
  function firstCall(): unknown[] {
    return (fetchMock.mock.calls as unknown[][])[0];
  }

  /** 用 env map 造一个 ConfigService，构造 LlmService */
  function createService(env: Record<string, string>) {
    const configService = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;
    return new LlmService(
      {} as unknown as LlmModelRegistryService,
      {} as unknown as LlmChatModelFactory,
      configService,
    );
  }

  /** 一枚成功的生图响应（url 形态） */
  function okImageResponse() {
    return {
      ok: true,
      json: () =>
        Promise.resolve({ data: [{ url: 'https://cdn.example/out.png' }] }),
    } as unknown as Response;
  }

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  const SEEDREAM_ENV = {
    IMAGE_GEN_PROVIDER: 'seedream',
    IMAGE_GEN_SEEDREAM_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3',
    IMAGE_GEN_SEEDREAM_API_KEY: 'sk-ark',
    IMAGE_GEN_SEEDREAM_MODEL: 'doubao-seedream-4-5-251128',
  };

  const OPENAI_ENV = {
    IMAGE_GEN_PROVIDER: 'openai',
    IMAGE_GEN_BASE_URL: 'https://api.openai-proxy.test/v1',
    IMAGE_GEN_API_KEY: 'sk-oa',
    IMAGE_GEN_MODEL: 'gpt-image-2',
  };

  it('缺省 provider 为 seedream：文生图打到 /images/generations（无 /v1 前缀）', async () => {
    // 不设 IMAGE_GEN_PROVIDER，仅给 seedream 三元组
    const { IMAGE_GEN_PROVIDER: _drop, ...envWithoutProvider } = SEEDREAM_ENV;
    const service = createService(envWithoutProvider);
    fetchMock.mockResolvedValue(okImageResponse());

    const result = await service.generateImage({ prompt: '一只柴犬' });

    const url = firstCall()[0] as string;
    expect(url).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    );
    const body = parseJsonBody(firstCall());
    expect(body).toMatchObject({
      model: 'doubao-seedream-4-5-251128',
      prompt: '一只柴犬',
      n: 1,
    });
    expect(result.url).toBe('https://cdn.example/out.png');
  });

  it('seedream 图生图：参考图以 data URI 放 image 字段（单张为字符串），同一 generations 端点', async () => {
    const service = createService(SEEDREAM_ENV);
    fetchMock.mockResolvedValue(okImageResponse());

    await service.editImage({
      prompt: '换成夜晚背景',
      images: [{ data: Buffer.from('abc'), mimeType: 'image/PNG' }],
    });

    const url = firstCall()[0] as string;
    expect(url).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    );
    const body = parseJsonBody(firstCall());
    // 单张 → 字符串；mime 小写；base64 编码
    expect(body.image).toBe(
      `data:image/png;base64,${Buffer.from('abc').toString('base64')}`,
    );
  });

  it('seedream 图生图：多张参考图 image 为数组', async () => {
    const service = createService(SEEDREAM_ENV);
    fetchMock.mockResolvedValue(okImageResponse());

    await service.editImage({
      prompt: '融合两张图',
      images: [
        { data: Buffer.from('a'), mimeType: 'image/png' },
        { data: Buffer.from('b'), mimeType: 'image/jpeg' },
      ],
    });

    const body = parseJsonBody(firstCall());
    expect(Array.isArray(body.image)).toBe(true);
    expect(body.image).toHaveLength(2);
  });

  it('openai 图生图：走独立 multipart /v1/images/edits（body 为 FormData）', async () => {
    const service = createService(OPENAI_ENV);
    fetchMock.mockResolvedValue(okImageResponse());

    await service.editImage({
      prompt: '改图',
      images: [{ data: Buffer.from('x'), mimeType: 'image/png' }],
    });

    const url = firstCall()[0] as string;
    const init = firstCall()[1] as RequestInit;
    // base URL 末尾 /v1 被归一化去掉后代码再拼 /v1/images/edits
    expect(url).toBe('https://api.openai-proxy.test/v1/images/edits');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it.each([
    ['1024x1024', '2048x2048'],
    ['1024x1536', '1664x2496'],
    ['1536x1024', '2496x1664'],
  ])(
    'seedream 尺寸映射：工具层 %s → %s（满足像素下限）',
    async (toolSize, expected) => {
      const service = createService(SEEDREAM_ENV);
      fetchMock.mockResolvedValue(okImageResponse());

      await service.generateImage({ prompt: 'x', size: toolSize });

      const body = parseJsonBody(firstCall());
      expect(body.size).toBe(expected);
      expect(pixelsOf(body.size!)).toBeGreaterThanOrEqual(SEEDREAM_MIN_PIXELS);
    },
  );

  it('seedream 不传尺寸：兜底为默认方图（不省略 size，避免触发下限报错）', async () => {
    const service = createService(SEEDREAM_ENV);
    fetchMock.mockResolvedValue(okImageResponse());

    await service.generateImage({ prompt: 'x' });

    const body = parseJsonBody(firstCall());
    expect(body.size).toBe('2048x2048');
  });

  it('seedream 图生图同样映射尺寸', async () => {
    const service = createService(SEEDREAM_ENV);
    fetchMock.mockResolvedValue(okImageResponse());

    await service.editImage({
      prompt: '改图',
      images: [{ data: Buffer.from('a'), mimeType: 'image/png' }],
      size: '1536x1024',
    });

    const body = parseJsonBody(firstCall());
    expect(body.size).toBe('2496x1664');
  });

  it('openai 分支不做映射：尺寸原样透传', async () => {
    const service = createService(OPENAI_ENV);
    fetchMock.mockResolvedValue(okImageResponse());

    await service.generateImage({ prompt: 'x', size: '1024x1024' });

    const body = parseJsonBody(firstCall());
    expect(body.size).toBe('1024x1024');
  });

  it('激活 provider 未配置 key：抛 503', async () => {
    const service = createService({ IMAGE_GEN_PROVIDER: 'seedream' });
    await expect(service.generateImage({ prompt: 'x' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
