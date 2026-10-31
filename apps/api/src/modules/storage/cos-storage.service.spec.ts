import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { buildRenderVideoObjectKey } from '../html-render/render-object-key';
import { CosObjectWriteError, CosStorageService } from './cos-storage.service';

interface CosGetObjectUrlParams {
  Key: string;
}

type CosGetObjectUrlCallback = (
  error: Error | null,
  data: { Url: string },
) => void;

type CosGetObjectUrl = (
  params: CosGetObjectUrlParams,
  callback: CosGetObjectUrlCallback,
) => void;

interface NodeStateInsert {
  data: Array<{
    taskId: string;
    nodeExecutionId: string;
    nodeKey: string;
    state: Record<string, string | number>;
  }>;
  skipDuplicates: boolean;
}

const mockGetObjectUrl = jest.fn<CosGetObjectUrl>();
const mockHeadObject = jest.fn();
const mockGetObject = jest.fn();
const mockGetBucketVersioning = jest.fn();
const mockFindNodeState = jest.fn();
const mockCreateNodeState = jest.fn();

jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: jest.fn(() => ({
    agentFlowNodeState: {
      findUnique: mockFindNodeState,
      createMany: mockCreateNodeState,
    },
  })),
}));

// 不能加 { virtual: true }：cos-nodejs-sdk-v5 是真实依赖，虚拟 mock 按模块名注册而非解析路径；
// 同一 worker 内若有别的 spec 先解析过该模块，mock 会失效，本 spec 会打到真实 COS SDK 并签出真签名。
jest.mock('cos-nodejs-sdk-v5', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getObjectUrl: mockGetObjectUrl,
    headObject: mockHeadObject,
    getObject: mockGetObject,
    getBucketVersioning: mockGetBucketVersioning,
  })),
}));

describe('CosStorageService', () => {
  // 多个服务实例共享同一个唯一约束替身，不把进程内互斥冒充跨进程保证。
  const nodeStates = new Map<
    string,
    {
      nodeKey: string;
      state: Record<string, string | number>;
    }
  >();
  /**
   * 创建 COS 存储服务测试实例
   * @param overrides 要覆盖的 COS 环境配置
   * @returns 返回使用内存配置表创建的 COS 存储服务
   * @description 通过 ConfigService 的最小替身隔离环境变量，避免测试访问真实云端或凭据。
   */
  const createService = (
    overrides: Record<string, string | undefined> = {},
  ) => {
    const config: Record<string, string | undefined> = {
      COS_SECRET_ID: 'test-secret-id',
      COS_SECRET_KEY: 'test-secret-key',
      COS_BUCKET: 'litter-bear-1250000000',
      COS_REGION: 'ap-guangzhou',
      COS_BUCKET_DOMAIN: 'https://cdn.example.com/',
      ...overrides,
    };
    return new CosStorageService(
      new ConfigService(config),
      new PrismaService(),
    );
  };

  /**
   * 模拟 PostgreSQL 唯一键插入，多个服务实例共享同一份已提交声明
   * @param query 产品代码传入的声明及跳过冲突选项
   * @returns 返回真实 createMany 对应的插入行数，不模拟 COS 互斥
   */
  function insertNodeState(query: NodeStateInsert): Promise<{ count: number }> {
    expect(query.skipDuplicates).toBe(true);
    const data = query.data[0];
    const key = JSON.stringify([data.taskId, data.nodeExecutionId]);
    if (nodeStates.has(key)) return Promise.resolve({ count: 0 });
    nodeStates.set(key, { nodeKey: data.nodeKey, state: data.state });
    return Promise.resolve({ count: 1 });
  }

  beforeEach(() => {
    mockGetObjectUrl.mockReset();
    mockHeadObject.mockReset();
    mockGetObject.mockReset();
    mockGetBucketVersioning.mockReset();
    nodeStates.clear();
    mockFindNodeState.mockReset();
    mockFindNodeState.mockImplementation(
      (query: {
        where: {
          taskId_nodeExecutionId: { taskId: string; nodeExecutionId: string };
        };
      }) => {
        const { taskId, nodeExecutionId } = query.where.taskId_nodeExecutionId;
        return Promise.resolve(
          nodeStates.get(JSON.stringify([taskId, nodeExecutionId])) ?? null,
        );
      },
    );
    mockCreateNodeState.mockReset();
    mockCreateNodeState.mockImplementation(insertNodeState);
  });

  it('从 COS HEAD 读取真实对象大小与 MIME', async () => {
    mockHeadObject.mockResolvedValue({
      headers: {
        'content-length': '2048',
        'content-type': 'image/webp; charset=binary',
      },
    });
    const service = createService();

    await expect(
      service.getObjectMetadata('image/path/a.webp'),
    ).resolves.toEqual({
      contentLength: 2048,
      contentType: 'image/webp',
    });
  });

  it('下载图片时使用 maxBytes Range 并拒绝超限响应体', async () => {
    mockHeadObject.mockResolvedValue({
      headers: {
        'content-length': '4',
        'content-type': 'image/png',
      },
    });
    mockGetObject.mockResolvedValue({ Body: Buffer.alloc(5) });
    const service = createService();

    await expect(service.downloadObject('image/path/a.png', 4)).rejects.toThrow(
      '不能超过 4 字节',
    );
    expect(mockGetObject).toHaveBeenCalledWith(
      expect.objectContaining({ Range: 'bytes=0-4' }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('为图片对象签发固定 key 的 HTTPS PUT URL 与确定的 Content-Type', async () => {
    mockGetObjectUrl.mockImplementation(
      (params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: `https://litter-bear-1250000000.cos.ap-guangzhou.myqcloud.com/${params.Key}?signature=test`,
        });
      },
    );
    const service = createService();

    const credential = await service.createUploadCredential(
      'user-1',
      'image',
      'PNG',
    );

    expect(credential.key).toMatch(/^image\/\d{6}\/user-1\/[0-9a-f]{32}\.png$/);
    expect(mockGetObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'litter-bear-1250000000',
        Region: 'ap-guangzhou',
        Key: credential.key,
        Method: 'PUT',
        Sign: true,
        Expires: 600,
        Protocol: 'https:',
        Headers: { 'Content-Type': 'image/png' },
      }),
      expect.any(Function),
    );
    expect(credential.uploadUrl).toBe(
      `https://litter-bear-1250000000.cos.ap-guangzhou.myqcloud.com/${credential.key}?signature=test`,
    );
    expect(credential.accessUrl).toBe(
      `https://cdn.example.com/${credential.key}`,
    );
    expect(credential.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
  });

  it('COS SDK 回调错误时拒绝签发上传凭证', async () => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(new Error('签名服务不可用'), { Url: '' });
      },
    );
    const service = createService();

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('腾讯云 COS 上传凭证签发失败');
  });

  it('COS SDK 返回非 HTTPS URL 时拒绝签发上传凭证', async () => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, { Url: 'http://upload.example.com/key?signature=test' });
      },
    );
    const service = createService();

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('腾讯云 COS 未返回 HTTPS 上传地址');
  });

  it.each([
    ['image', 'mp3'],
    ['audio', 'png'],
    ['image', 'exe'],
  ] as const)(
    '%s 类型不支持 .%s 扩展名时拒绝签发上传凭证',
    async (type, ext) => {
      mockGetObjectUrl.mockImplementation(
        (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
          callback(null, {
            Url: 'https://upload.example.com/key?signature=test',
          });
        },
      );
      const service = createService();

      await expect(
        service.createUploadCredential('user-1', type, ext),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createUploadCredential('user-1', type, ext),
      ).rejects.toThrow('不支持的媒体扩展名');
      expect(mockGetObjectUrl).not.toHaveBeenCalled();
    },
  );

  it.each([
    'COS_SECRET_ID',
    'COS_SECRET_KEY',
    'COS_BUCKET',
    'COS_REGION',
    'COS_BUCKET_DOMAIN',
  ])('缺少 %s 时只在签发 COS 凭证时抛出明确的 503', async (key) => {
    const service = createService({ [key]: undefined });

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('COS 对象存储未配置');
  });

  it.each([
    ['COS_BUCKET', 'litter-bear'],
    ['COS_REGION', 'na-toronto'],
  ])('%s 格式非法时拒绝签发 COS 上传 URL', async (key, value) => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: 'https://upload.example.com/key?signature=test',
        });
      },
    );
    const service = createService({ [key]: value });

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('COS 对象存储配置无效');
    expect(mockGetObjectUrl).not.toHaveBeenCalled();
  });

  it('将无协议的 COS 访问域名规范化为 HTTPS 基址', async () => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: 'https://upload.example.com/key?signature=test',
        });
      },
    );
    const service = createService({
      COS_BUCKET_DOMAIN: 'cdn.example.com////',
    });

    const credential = await service.createUploadCredential(
      'user-1',
      'audio',
      'mp3',
    );

    expect(credential.accessUrl).toBe(
      `https://cdn.example.com/${credential.key}`,
    );
    expect(credential.headers).toEqual({ 'Content-Type': 'audio/mpeg' });
  });

  it('使用公有读域名生成访问 URL，并对 key 中的特殊字符逐段编码', () => {
    const service = createService();

    expect(service.resolveAccessUrl('image/202609/user-1/a b#c.png')).toBe(
      'https://cdn.example.com/image/202609/user-1/a%20b%23c.png',
    );
  });

  it.each(['', '../secret.png', '/absolute.png', 'https://evil.example/a.png'])(
    '对象 key %p 不安全时拒绝生成访问 URL',
    (key) => {
      const service = createService();

      expect(() => service.resolveAccessUrl(key)).toThrow(BadRequestException);
    },
  );

  it('服务端二进制通过预签名 PUT 上传成功后返回对象 key', async () => {
    mockGetObjectUrl.mockImplementation(
      (params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: `https://upload.example.com/${params.Key}?signature=test`,
        });
      },
    );
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const service = createService();
    const data = Buffer.from('image-data');

    const key = await service.uploadBuffer({
      data,
      ownerId: 'user-1',
      type: 'image',
      ext: 'png',
    });

    expect(key).toMatch(/^image\/\d{6}\/user-1\/[0-9a-f]{32}\.png$/);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(`/${key}?signature=test`),
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
      }),
    );
  });

  it('服务端二进制上传失败时抛出 COS 响应状态与摘要', async () => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: 'https://upload.example.com/object?signature=test',
        });
      },
    );
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('AccessDenied', { status: 403 }));
    const service = createService();

    await expect(
      service.uploadBuffer({
        data: Buffer.from('image-data'),
        ownerId: 'user-1',
        type: 'image',
        ext: 'png',
      }),
    ).rejects.toThrow('腾讯云 COS 服务端上传失败(403)：AccessDenied');
  });

  it.each([
    ['路径', 'https://cdn.example.com/media'],
    ['查询参数', 'https://cdn.example.com?version=1'],
    ['用户信息', 'https://user:password@cdn.example.com'],
  ])('COS_BUCKET_DOMAIN 含%s时拒绝签发上传凭证', async (_kind, domain) => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: 'https://upload.example.com/key?signature=test',
        });
      },
    );
    const service = createService({ COS_BUCKET_DOMAIN: domain });

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('COS 对象存储配置无效');
    expect(mockGetObjectUrl).not.toHaveBeenCalled();
  });

  describe('幂等的服务端对象写入', () => {
    const execution = {
      taskId: 'task-1',
      nodeExecutionId: 'task-1:version-1:render#0',
      nodeKey: 'render',
      isTest: false,
    };
    const input = {
      key: buildRenderVideoObjectKey(execution),
      execution,
      data: new Blob(['mp4-data']),
      inputDigest: 'a'.repeat(64),
      contentType: 'video/mp4',
    };
    const expected = {
      execution,
      inputDigest: input.inputDigest,
      contentType: input.contentType,
    };
    let fetchSpy: jest.SpyInstance<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >;

    beforeEach(() => {
      mockGetBucketVersioning.mockResolvedValue({
        VersioningConfiguration: {},
      });
      mockGetObjectUrl.mockImplementation((_params, callback) => {
        callback(null, {
          Url: 'https://upload.example.com/object?signature=test',
        });
      });
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null));
    });

    /**
     * 构造本次服务端签名写入产生的完整元数据
     * @param overrides 用于模拟损坏或冲突的响应头
     * @returns 返回合法 COS HEAD 响应的最小形状
     */
    function metadata(overrides: Record<string, string | undefined> = {}) {
      return {
        headers: {
          'content-length': '8',
          'content-type': 'video/mp4',
          'x-cos-meta-input-sha256': input.inputDigest,
          'x-cos-meta-content-sha256': createHash('sha256')
            .update('mp4-data')
            .digest('hex'),
          ...overrides,
        },
      };
    }

    it('对象及内容一致时不再上传', async () => {
      await insertNodeState({
        data: [
          {
            taskId: execution.taskId,
            nodeExecutionId: execution.nodeExecutionId,
            nodeKey: execution.nodeKey,
            state: {
              kind: 'cos-write-once',
              bucket: 'litter-bear-1250000000',
              region: 'ap-guangzhou',
              key: input.key,
              inputDigest: input.inputDigest,
              contentType: input.contentType,
              contentSha256: createHash('sha256')
                .update('mp4-data')
                .digest('hex'),
              contentLength: 8,
            },
          },
        ],
        skipDuplicates: true,
      });
      mockHeadObject.mockResolvedValue(metadata());
      await expect(createService().putObjectIfAbsent(input)).resolves.toEqual({
        key: input.key,
        created: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('已有对象没有上传声明时拒绝恢复，且不补写声明或发送 PUT', async () => {
      mockHeadObject.mockResolvedValue(metadata());
      await expect(
        createService().objectExists(input.key, expected),
      ).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
      await expect(
        createService().putObjectIfAbsent(input),
      ).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
      expect(mockCreateNodeState).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('首次读库后另一个 attempt 已上传时重新读取声明再恢复', async () => {
      let firstRead = true;
      mockFindNodeState.mockImplementation(() => {
        if (firstRead) {
          firstRead = false;
          return Promise.resolve(null);
        }
        return Promise.resolve({
          nodeKey: execution.nodeKey,
          state: {
            kind: 'cos-write-once',
            bucket: 'litter-bear-1250000000',
            region: 'ap-guangzhou',
            key: input.key,
            inputDigest: input.inputDigest,
            contentType: input.contentType,
            contentSha256: createHash('sha256')
              .update('mp4-data')
              .digest('hex'),
            contentLength: 8,
          },
        });
      });
      mockHeadObject.mockResolvedValue(metadata());
      await expect(
        createService().objectExists(input.key, expected),
      ).resolves.toBe(true);
      expect(mockFindNodeState).toHaveBeenCalledTimes(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('并发补读的声明与对象不一致时仍然拒绝恢复', async () => {
      mockFindNodeState.mockResolvedValueOnce(null).mockResolvedValue({
        nodeKey: execution.nodeKey,
        state: {
          kind: 'cos-write-once',
          bucket: 'litter-bear-1250000000',
          region: 'ap-guangzhou',
          key: input.key,
          inputDigest: input.inputDigest,
          contentType: input.contentType,
          contentSha256: 'b'.repeat(64),
          contentLength: 8,
        },
      });
      mockHeadObject.mockResolvedValue(metadata());
      await expect(
        createService().objectExists(input.key, expected),
      ).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('对象不存在时签名禁止覆盖与校验头，并流式发送 Blob', async () => {
      mockHeadObject
        .mockRejectedValueOnce(cosError(404))
        .mockResolvedValueOnce(metadata());
      await expect(createService().putObjectIfAbsent(input)).resolves.toEqual({
        key: input.key,
        created: true,
      });
      const headers = {
        'Content-Type': 'video/mp4',
        'Content-MD5': createHash('md5').update('mp4-data').digest('base64'),
        'x-cos-forbid-overwrite': 'true',
        'x-cos-meta-input-sha256': input.inputDigest,
        'x-cos-meta-content-sha256': createHash('sha256')
          .update('mp4-data')
          .digest('hex'),
      };
      expect(mockGetObjectUrl).toHaveBeenCalledWith(
        expect.objectContaining({ Key: input.key, Headers: headers }),
        expect.any(Function),
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://upload.example.com/object?signature=test',
        expect.objectContaining({
          method: 'PUT',
          body: input.data,
          headers,
          redirect: 'error',
        }),
      );
    });

    it('并发 attempt 的 409 仅在内容一致时复用', async () => {
      mockHeadObject
        .mockRejectedValueOnce(cosError(404))
        .mockResolvedValueOnce(metadata());
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 409 }));
      await expect(createService().putObjectIfAbsent(input)).resolves.toEqual({
        key: input.key,
        created: false,
      });
    });

    it('即使 COS 对所有竞争 PUT 都返回 200，也只发出一次写入', async () => {
      let storedObject: ReturnType<typeof metadata> | undefined;
      let initialReads = 0;
      let releaseInitialReads!: () => void;
      const bothInitialReads = new Promise<void>((resolve) => {
        releaseInitialReads = resolve;
      });
      mockHeadObject.mockImplementation(async () => {
        if (storedObject) return storedObject;
        initialReads += 1;
        if (initialReads === 2) releaseInitialReads();
        await bothInitialReads;
        throw cosError(404);
      });
      const putStatuses: number[] = [];
      // 复现真实桶的语义：不能再用 mock 的 409 证明互斥。每次 PUT 都会覆盖并返回 200。
      fetchSpy.mockImplementation((_url, init) => {
        expect(init?.body).toBe(input.data);
        storedObject = metadata();
        putStatuses.push(200);
        return Promise.resolve(new Response(null, { status: 200 }));
      });
      const results = await Promise.all([
        createService().putObjectIfAbsent(input),
        createService().putObjectIfAbsent(input),
      ]);
      expect(results.map((result) => result.created).sort()).toEqual([
        false,
        true,
      ]);
      expect(results.map((result) => result.key)).toEqual([
        input.key,
        input.key,
      ]);
      expect(putStatuses).toEqual([200]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('相同 key 的不同内容竞争只允许一个 PUT，另一份内容明确冲突', async () => {
      let storedObject: ReturnType<typeof metadata> | undefined;
      let reads = 0;
      let release!: () => void;
      const bothReads = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockHeadObject.mockImplementation(async () => {
        if (storedObject) return storedObject;
        if (++reads === 2) release();
        await bothReads;
        throw cosError(404);
      });
      fetchSpy.mockImplementation((_url, init) => {
        const headers = new Headers(init?.headers);
        storedObject = metadata({
          'x-cos-meta-content-sha256':
            headers.get('x-cos-meta-content-sha256') ?? '',
        });
        return Promise.resolve(new Response(null, { status: 200 }));
      });
      const results = await Promise.allSettled([
        createService().putObjectIfAbsent(input),
        createService().putObjectIfAbsent({
          ...input,
          data: new Blob(['bad-data']),
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === 'rejected'),
      ).toMatchObject({
        reason: { code: 'OBJECT_CONFLICT' },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const state = [...nodeStates.values()][0].state;
      expect(storedObject?.headers['x-cos-meta-content-sha256']).toBe(
        state.contentSha256,
      );
    });

    it('旧 PUT 仍在途时另一实例只能等待只读恢复，不能获得写入权', async () => {
      let storedObject: ReturnType<typeof metadata> | undefined;
      let release!: () => void;
      let sent!: () => void;
      const started = new Promise<void>((resolve) => {
        sent = resolve;
      });
      mockHeadObject.mockImplementation(() =>
        storedObject
          ? Promise.resolve(storedObject)
          : Promise.reject(cosError(404)),
      );
      fetchSpy.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => {
              storedObject = metadata();
              resolve(new Response(null));
            };
            sent();
          }),
      );
      const first = createService().putObjectIfAbsent(input);
      await started;
      await expect(
        createService().putObjectIfAbsent(input),
      ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });
      await expect(
        createService().objectExists(input.key, expected),
      ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      release();
      await expect(first).resolves.toMatchObject({ created: true });
      await expect(
        createService().putObjectIfAbsent(input),
      ).resolves.toMatchObject({ created: false });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('取消不能撤回远端在途请求，保留声明直到对象可只读恢复', async () => {
      const controller = new AbortController();
      let storedObject: ReturnType<typeof metadata> | undefined;
      let commitRemote!: () => void;
      mockHeadObject.mockImplementation(() =>
        storedObject
          ? Promise.resolve(storedObject)
          : Promise.reject(cosError(404)),
      );
      fetchSpy.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            commitRemote = () => {
              storedObject = metadata();
            };
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('已取消', 'AbortError')),
              { once: true },
            );
            controller.abort();
          }),
      );
      await expect(
        createService().putObjectIfAbsent({
          ...input,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await expect(
        createService().putObjectIfAbsent(input),
      ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });
      commitRemote();
      await expect(
        createService().objectExists(input.key, expected),
      ).resolves.toBe(true);
      await expect(
        createService().putObjectIfAbsent(input),
      ).resolves.toMatchObject({ created: false });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mockCreateNodeState).toHaveBeenCalledTimes(1);
    });

    it('网络失败且一天后仍 404 时保持未知，不能按超时或进程更换接管', async () => {
      mockHeadObject.mockRejectedValue(cosError(404));
      fetchSpy.mockRejectedValueOnce(new Error('connection lost'));
      await expect(createService().putObjectIfAbsent(input)).rejects.toThrow(
        'connection lost',
      );
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60_000);
      await expect(
        createService().objectExists(input.key, expected),
      ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });
      await expect(
        createService().putObjectIfAbsent(input),
      ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mockCreateNodeState).toHaveBeenCalledTimes(1);
    });

    it('数据库声明提交前不会发送 PUT，提交应答丢失也不会重发', async () => {
      mockHeadObject.mockRejectedValue(cosError(404));
      mockCreateNodeState.mockImplementationOnce(
        async (query: NodeStateInsert) => {
          await insertNodeState(query);
          expect(fetchSpy).not.toHaveBeenCalled();
          throw new Error('数据库提交应答丢失');
        },
      );
      await expect(createService().putObjectIfAbsent(input)).rejects.toThrow(
        '数据库提交应答丢失',
      );
      await expect(
        createService().putObjectIfAbsent(input),
      ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(nodeStates.size).toBe(1);
    });

    it('声明成功但 PUT 前取消也保留声明，不能猜测另一进程的发出阶段', async () => {
      const controller = new AbortController();
      mockHeadObject.mockRejectedValue(cosError(404));
      mockCreateNodeState.mockImplementationOnce(
        async (query: NodeStateInsert) => {
          const result = await insertNodeState(query);
          controller.abort();
          return result;
        },
      );
      await expect(
        createService().putObjectIfAbsent({
          ...input,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await expect(
        createService().objectExists(input.key, expected),
      ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(nodeStates.size).toBe(1);
    });

    it('恢复必须匹配数据库固定的内容摘要，不只检查 COS 中的输入摘要', async () => {
      mockHeadObject
        .mockRejectedValueOnce(cosError(404))
        .mockResolvedValue(metadata());
      await createService().putObjectIfAbsent(input);
      mockHeadObject.mockResolvedValue(
        metadata({
          'x-cos-meta-content-sha256': createHash('sha256')
            .update('bad-data')
            .digest('hex'),
        }),
      );
      await expect(
        createService().objectExists(input.key, expected),
      ).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('不能用另一节点执行身份写入相同对象 key', async () => {
      await expect(
        createService().putObjectIfAbsent({
          ...input,
          execution: { ...execution, nodeExecutionId: 'other#0' },
        }),
      ).rejects.toThrow('对象 key 与节点执行身份不一致');
      expect(mockCreateNodeState).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('损坏的节点声明不能静默当作无声明', async () => {
      mockFindNodeState.mockResolvedValue({ nodeKey: 'render', state: {} });
      await expect(
        createService().objectExists(input.key, expected),
      ).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
      await expect(
        createService().putObjectIfAbsent(input),
      ).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
      expect(mockHeadObject).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('数据库不可读时不退化为直接上传', async () => {
      mockFindNodeState.mockRejectedValue(new Error('数据库不可用'));
      await expect(createService().putObjectIfAbsent(input)).rejects.toThrow(
        '数据库不可用',
      );
      expect(mockHeadObject).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('409 之后仍读不到对象时失败，不假装成功', async () => {
      mockHeadObject.mockRejectedValue(cosError(404));
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 409 }));
      await expect(
        createService().putObjectIfAbsent(input),
      ).rejects.toMatchObject({
        code: 'WRITE_UNCONFIRMED',
      });
    });

    it.each([200, 409])('%s 后同大小不同内容必须报冲突', async (status) => {
      mockHeadObject.mockRejectedValueOnce(cosError(404)).mockResolvedValueOnce(
        metadata({
          'x-cos-meta-content-sha256': createHash('sha256')
            .update('bad-data')
            .digest('hex'),
        }),
      );
      fetchSpy.mockResolvedValueOnce(new Response(null, { status }));
      await expect(
        createService().putObjectIfAbsent(input),
      ).rejects.toBeInstanceOf(CosObjectWriteError);
    });

    it('写入后字节数不一致时失败', async () => {
      mockHeadObject
        .mockRejectedValueOnce(cosError(404))
        .mockResolvedValueOnce(metadata({ 'content-length': '3' }));
      await expect(
        createService().putObjectIfAbsent(input),
      ).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
    });

    it.each([
      { 'x-cos-meta-input-sha256': 'b'.repeat(64) },
      { 'x-cos-meta-content-sha256': undefined },
      { 'content-type': 'text/plain' },
    ])('重放不接受另一份输入或缺失完整性标记：%j', async (headers) => {
      mockHeadObject.mockResolvedValue(metadata(headers));
      await expect(
        createService().objectExists(input.key, expected),
      ).rejects.toMatchObject({
        code: 'OBJECT_CONFLICT',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each(['Enabled', 'Suspended', 'unknown'])(
      '版本控制为 %s 时拒绝读写幂等对象',
      async (status) => {
        mockGetBucketVersioning.mockResolvedValue({
          VersioningConfiguration: { Status: status },
        });
        const service = createService();
        await expect(
          service.objectExists(input.key, expected),
        ).rejects.toMatchObject({ code: 'VERSIONING_UNSAFE' });
        await expect(service.putObjectIfAbsent(input)).rejects.toMatchObject({
          code: 'VERSIONING_UNSAFE',
        });
        expect(mockHeadObject).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );

    it('不能读取版本控制配置时不尝试上传', async () => {
      mockGetBucketVersioning.mockRejectedValue(cosError(403));
      await expect(createService().putObjectIfAbsent(input)).rejects.toThrow(
        '版本控制状态读取失败',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('HEAD 的权限错误不会被当成对象不存在', async () => {
      mockHeadObject.mockRejectedValue(cosError(403));
      const service = createService();
      await expect(service.objectExists(input.key, expected)).rejects.toThrow(
        '腾讯云 COS 拒绝读取对象元数据',
      );
      await expect(service.putObjectIfAbsent(input)).rejects.toThrow(
        '腾讯云 COS 拒绝读取对象元数据',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([new Error('socket hang up'), null, 'connection lost'])(
      '未知 HEAD 异常 %p 仍为明确失败',
      async (error) => {
        mockHeadObject.mockRejectedValue(error);
        await expect(
          createService().objectExists(input.key, expected),
        ).rejects.toThrow('腾讯云 COS 对象存在性检查失败');
      },
    );

    it('预先取消时连 COS 检查都不执行', async () => {
      const signal = AbortSignal.abort();
      await expect(
        createService().putObjectIfAbsent({ ...input, signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(mockGetBucketVersioning).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('上传期间取消会传给 HTTP 请求且不回写成功', async () => {
      const controller = new AbortController();
      mockHeadObject.mockRejectedValue(cosError(404));
      fetchSpy.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('上传缺少取消信号');
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('上传已取消', 'AbortError')),
              { once: true },
            );
            controller.abort();
          }),
      );
      await expect(
        createService().putObjectIfAbsent({
          ...input,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(mockHeadObject).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * 构造一个带 HTTP 状态码的 COS SDK 异常
 * @param statusCode 要模拟的 HTTP 状态码
 * @returns 返回 COS SDK 常见的错误形状
 */
function cosError(statusCode: number) {
  return Object.assign(new Error(`COS ${statusCode}`), { statusCode });
}
