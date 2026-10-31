import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import COS from 'cos-nodejs-sdk-v5';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildRenderVideoObjectKey,
  type RenderVideoObjectInput,
} from '../html-render/render-object-key';
import type { UploadMediaType } from './dto/upload-credential.dto';

/** COS 预签名上传 URL 的有效期（秒） */
const UPLOAD_URL_TTL_SECONDS = 600;
/** 腾讯云 COS bucket 名：小写名称加 -appid 后缀 */
const COS_BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?-\d{6,10}$/;
/** 本项目支持的 COS 区域格式：ap-{region} */
const COS_REGION_PATTERN = /^ap-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 可签发的媒体类型与扩展名到 MIME 类型的唯一闭集 */
const CONTENT_TYPES: Readonly<
  Record<UploadMediaType, Readonly<Record<string, string>>>
> = {
  image: {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
  },
  audio: {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    aac: 'audio/aac',
    amr: 'audio/amr',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
  },
};

interface CosStorageConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  domain: string;
}

export interface CosUploadCredential {
  key: string;
  uploadUrl: string;
  accessUrl: string;
  headers: { 'Content-Type': string };
  expiresAt: number;
}

export interface CosObjectMetadata {
  contentLength: number;
  contentType: string;
}

export interface CosDownloadedObject extends CosObjectMetadata {
  body: Buffer;
}

/** 与稳定对象 key 一一对应的节点执行身份；不包含可过期的 attempt 或租约。 */
export interface CosObjectExecution extends RenderVideoObjectInput {
  nodeKey: string;
}

/** 幂等对象必须属于同一份冻结输入；已拿到成片时还须逐字节摘要一致。 */
export interface CosObjectExpectation {
  execution: CosObjectExecution;
  inputDigest: string;
  contentType: string;
  contentSha256?: string;
  contentLength?: number;
}

/** 对象写入失败；只有结果未确认允许有限次只读恢复，其余均为确定性冲突。 */
export class CosObjectWriteError extends Error {
  constructor(
    readonly code:
      'VERSIONING_UNSAFE' | 'OBJECT_CONFLICT' | 'WRITE_UNCONFIRMED',
    message: string,
  ) {
    super(message);
    this.name = 'CosObjectWriteError';
  }
}

/**
 * 腾讯云 COS 对象存储
 * @description 统一签发单对象 HTTPS PUT 预签名 URL、生成公有读访问 URL，
 * 并为 AI 生图等服务端自产内容提供二进制上传能力。
 */
@Injectable()
export class CosStorageService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 签发小程序直传 COS 的单对象上传凭证
   * @param userId 上传者 ID，用于归属对象 key
   * @param type 媒体类型，决定 image 或 audio 目录
   * @param ext 文件扩展名，已由调用方 DTO 校验为字母数字
   * @returns 返回对象 key、HTTPS PUT URL、访问 URL、必填请求头和过期时间
   * @description 每次调用只对一个新 key 签名十分钟，凭证不允许泛化到其他对象。
   */
  async createUploadCredential(
    userId: string,
    type: UploadMediaType,
    ext: string,
  ): Promise<CosUploadCredential> {
    const contentType = this.resolveContentType(type, ext);
    const config = this.requireConfig();
    const key = this.buildObjectKey(type, userId, ext);
    const headers = { 'Content-Type': contentType };
    const uploadUrl = await this.createSignedPutUrl(config, key, headers);

    return {
      key,
      uploadUrl,
      accessUrl: this.buildAccessUrl(config.domain, key),
      headers,
      expiresAt: Date.now() + UPLOAD_URL_TTL_SECONDS * 1000,
    };
  }

  /**
   * 生成公开对象访问 URL
   * @param key 已登记的 COS 对象 key
   * @returns 返回由访问域名与安全编码 key 组成的稳定 URL
   * @description 当前存储桶采用公有读、私有写，读取不签名；仍校验 key，避免路径或协议注入。
   */
  resolveAccessUrl(key: string): string {
    const config = this.requireConfig();
    return this.buildAccessUrl(config.domain, key);
  }

  /**
   * 将服务端生成的二进制上传至 COS
   * @param input 数据、归属用户、媒体类型与扩展名
   * @returns 返回上传成功的对象 key
   * @description 复用单对象预签名 PUT 约束，供 AI 生图等服务端自产内容持久化；失败时不登记资产。
   */
  async uploadBuffer(input: {
    data: Buffer;
    ownerId: string;
    type: UploadMediaType;
    ext: string;
  }): Promise<string> {
    const credential = await this.createUploadCredential(
      input.ownerId,
      input.type,
      input.ext,
    );
    const response = await fetch(credential.uploadUrl, {
      method: 'PUT',
      headers: credential.headers,
      body: new Blob([new Uint8Array(input.data)]),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `腾讯云 COS 服务端上传失败(${response.status})：${detail.slice(0, 200)}`,
      );
    }
    return credential.key;
  }

  /**
   * 检查是否存在与本次冻结输入一致的完整对象
   * @param key 由稳定执行标识生成的对象 key
   * @param expected 稳定节点身份、预期输入摘要、MIME 及可选的成片摘要与大小
   * @returns 无上传声明且 404 才返回 false；已声明但未读到对象时明确失败，禁止重新渲染上传
   * @description 恢复时同时核对数据库中不可变的上传声明和 COS 元数据，不能把另一个
   * attempt 的内容或丢失声明后的未知对象当作本次上传的成功结果。
   */
  async objectExists(
    key: string,
    expected: CosObjectExpectation,
  ): Promise<boolean> {
    this.assertObjectExecution(key, expected.execution);
    const config = this.requireConfig();
    await this.assertUnversionedBucket(config);
    return this.findMatchingWriteObject(config, key, expected);
  }

  /**
   * 以数据库一次性写入声明保护服务端自产对象
   * @param input 稳定节点身份及 key、文件 Blob、输入摘要、MIME 与取消信号
   * @returns 返回对象 key 与是否由本次调用创建；竞争者只能复用已核验对象或明确失败
   * @description 真实 COS 的禁止覆盖头不能阻止两个在途 PUT。先在既有节点私有状态表中
   * 以唯一键插入不可变声明，只有收到插入成功的调用能发送一次 PUT；不持有长事务，
   * 不使用会过期或随连接断开释放的锁。声明在取消、进程退出、网络或落库失败后均保留，
   * 后续 attempt 只读恢复，绝不接管写入权。未发送就退出也可能无法自动恢复，这是拒绝
   * 覆盖的必要取舍；不能通过删除声明或到期重发来猜测旧请求已经停止。
   *
   * Blob 流式计算摘要，Content-MD5 和完整性元数据参与签名；禁止覆盖头及未版本化检查
   * 仅作纵深防护，不再承担互斥。所有 Worker 必须使用同一业务库且升级前排空旧写入者。
   */
  async putObjectIfAbsent(input: {
    key: string;
    execution: CosObjectExecution;
    data: Blob;
    inputDigest: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<{ key: string; created: boolean }> {
    this.assertObjectExecution(input.key, input.execution);
    if (
      !input.contentType.trim() ||
      !/^[a-f0-9]{64}$/.test(input.inputDigest) ||
      input.data.size <= 0
    ) {
      throw new BadRequestException('幂等对象的输入摘要、内容类型或内容无效');
    }
    input.signal?.throwIfAborted();
    const config = this.requireConfig();
    await this.assertUnversionedBucket(config);
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    for await (const chunk of input.data.stream()) {
      input.signal?.throwIfAborted();
      sha256.update(chunk);
      md5.update(chunk);
    }
    const contentSha256 = sha256.digest('hex');
    const expected: CosObjectExpectation = {
      execution: input.execution,
      inputDigest: input.inputDigest,
      contentType: input.contentType,
      contentSha256,
      contentLength: input.data.size,
    };
    input.signal?.throwIfAborted();
    if (await this.findMatchingWriteObject(config, input.key, expected)) {
      return { key: input.key, created: false };
    }
    const headers = {
      'Content-Type': input.contentType,
      'Content-MD5': md5.digest('base64'),
      'x-cos-forbid-overwrite': 'true',
      'x-cos-meta-input-sha256': input.inputDigest,
      'x-cos-meta-content-sha256': contentSha256,
    };
    const uploadUrl = await this.createSignedPutUrl(config, input.key, headers);
    input.signal?.throwIfAborted();
    // 唯一键冲突不是接管：即使旧 attempt 已退出、超时或取消，也不能再发同 key 的 PUT。
    const claimed = await this.prisma.agentFlowNodeState.createMany({
      data: [
        {
          taskId: input.execution.taskId,
          nodeExecutionId: input.execution.nodeExecutionId,
          nodeKey: input.execution.nodeKey,
          state: {
            kind: 'cos-write-once',
            bucket: config.bucket,
            region: config.region,
            key: input.key,
            inputDigest: input.inputDigest,
            contentType: input.contentType,
            contentSha256,
            contentLength: input.data.size,
          },
        },
      ],
      skipDuplicates: true,
    });
    if (claimed.count !== 1) {
      if (await this.findMatchingWriteObject(config, input.key, expected)) {
        return { key: input.key, created: false };
      }
      throw this.unconfirmedWrite();
    }
    input.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(10 * 60_000);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers,
      body: input.data,
      redirect: 'error',
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    });
    await response.body?.cancel();
    input.signal?.throwIfAborted();
    if (!response.ok && response.status !== 409) {
      if (response.status === 403) {
        throw new ForbiddenException('腾讯云 COS 拒绝写入对象');
      }
      throw new ServiceUnavailableException('腾讯云 COS 对象写入失败');
    }
    // 包括 409 在内的所有结果都检查内容，而不是仅 HEAD 存在或仅比较大小。
    if (!(await this.findMatchingObject(config, input.key, expected))) {
      throw this.unconfirmedWrite();
    }
    return { key: input.key, created: response.ok };
  }

  /**
   * 校验对象 key 与持久化节点身份的一一对应关系
   * @param key 待检查的稳定对象 key
   * @param execution 任务创建时冻结的节点身份与测试标记
   * @returns 无返回值；不匹配时拒绝在不同声明下写入同一个 key
   * @description 对象 key 只由身份计算，不能用另一个任务或轮次绕过数据库唯一约束。
   */
  private assertObjectExecution(
    key: string,
    execution: CosObjectExecution,
  ): void {
    this.assertSafeKey(key);
    if (
      !execution.nodeKey.trim() ||
      buildRenderVideoObjectKey(execution) !== key
    ) {
      throw new BadRequestException('对象 key 与节点执行身份不一致');
    }
  }

  /**
   * 按不可变写入声明核验对象并阻止接管在途请求
   * @param config 已校验的 COS 配置
   * @param key 与节点身份唯一对应的对象 key
   * @param expected 冻结输入与可选的本地成片摘要
   * @returns 无声明且不存在时返回 false；对象完整一致时返回 true；其余明确失败
   * @description 节点状态只插入、不更新、不删除，也没有租约有效期。恢复必须用声明中的
   * 内容摘要与大小核验 COS，而不是仅信任相同输入摘要。数据库不可读时不退化为直接 PUT。
   */
  private async findMatchingWriteObject(
    config: CosStorageConfig,
    key: string,
    expected: CosObjectExpectation,
  ): Promise<boolean> {
    const where = {
      taskId_nodeExecutionId: {
        taskId: expected.execution.taskId,
        nodeExecutionId: expected.execution.nodeExecutionId,
      },
    };
    let row = await this.prisma.agentFlowNodeState.findUnique({
      where,
      select: { nodeKey: true, state: true },
    });
    if (!row) {
      if (!(await this.findMatchingObject(config, key, expected))) return false;
      // 首次读库与 HEAD 之间可能已有另一个 attempt 提交声明并完成上传，必须重新读取。
      row = await this.prisma.agentFlowNodeState.findUnique({
        where,
        select: { nodeKey: true, state: true },
      });
      if (!row) {
        throw new CosObjectWriteError(
          'OBJECT_CONFLICT',
          '腾讯云 COS 已有对象缺少上传声明，不能确认归属或恢复为成功',
        );
      }
    }
    let pinned = expected;
    if (row) {
      const state = row.state;
      if (
        !state ||
        typeof state !== 'object' ||
        Array.isArray(state) ||
        row.nodeKey !== expected.execution.nodeKey ||
        state.kind !== 'cos-write-once' ||
        state.bucket !== config.bucket ||
        state.region !== config.region ||
        state.key !== key ||
        state.inputDigest !== expected.inputDigest ||
        state.contentType !== expected.contentType ||
        typeof state.contentSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(state.contentSha256) ||
        typeof state.contentLength !== 'number' ||
        !Number.isSafeInteger(state.contentLength) ||
        state.contentLength <= 0 ||
        (expected.contentSha256 !== undefined &&
          expected.contentSha256 !== state.contentSha256) ||
        (expected.contentLength !== undefined &&
          expected.contentLength !== state.contentLength)
      ) {
        throw new CosObjectWriteError(
          'OBJECT_CONFLICT',
          '腾讯云 COS 上传声明与本次渲染的输入或内容不一致',
        );
      }
      pinned = {
        ...expected,
        contentSha256: state.contentSha256,
        contentLength: state.contentLength,
      };
    }
    const exists = await this.findMatchingObject(config, key, pinned);
    if (!exists) throw this.unconfirmedWrite();
    return exists;
  }

  /**
   * 生成禁止再次上传的结果未确认错误
   * @returns 返回可供 Activity 有限次只读恢复的错误，不承诺远端 PUT 已停止
   * @description 没读到对象既可能是请求在途，也可能是声明后进程退出，不能猜成可安全重发。
   */
  private unconfirmedWrite(): CosObjectWriteError {
    return new CosObjectWriteError(
      'WRITE_UNCONFIRMED',
      '腾讯云 COS 上传结果尚未确认，禁止重发同一对象的 PUT；请核对原任务或使用新任务',
    );
  }

  /**
   * 验证禁止覆盖写入的桶级前置条件
   * @param config 已校验的 COS 连接配置
   * @returns 无返回值；开启、暂停、未知状态或查询失败均拒绝写入
   * @description SDK 将从未开启版本控制的响应规范化为 VersioningConfiguration: {}。
   * Suspended 不等于从未开启，不能静默认作支持禁止覆盖的桶。
   */
  private async assertUnversionedBucket(
    config: CosStorageConfig,
  ): Promise<void> {
    let result: COS.GetBucketVersioningResult;
    try {
      result = await this.createClient(config).getBucketVersioning({
        Bucket: config.bucket,
        Region: config.region,
      });
    } catch {
      throw new ServiceUnavailableException('腾讯云 COS 版本控制状态读取失败');
    }
    const versioning: unknown = result.VersioningConfiguration;
    if (
      typeof versioning !== 'object' ||
      versioning === null ||
      Array.isArray(versioning) ||
      Reflect.get(versioning, 'Status') !== undefined
    ) {
      throw new CosObjectWriteError(
        'VERSIONING_UNSAFE',
        '渲染幂等写入要求 COS 桶从未启用版本控制',
      );
    }
  }

  /**
   * 核对对象元数据与本次幂等写入预期
   * @param config 已校验的 COS 连接配置
   * @param key 稳定对象 key
   * @param expected 冻结输入与已知成片信息
   * @returns 404 返回 false，其余仅在全部校验通过后返回 true
   * @description 元数据由私有写入的服务端随 Content-MD5 签名上传，不接受缺少完整性标记的
   * 历史对象；冲突时保留原对象并明确失败，不覆盖也不删除未知内容。
   */
  private async findMatchingObject(
    config: CosStorageConfig,
    key: string,
    expected: CosObjectExpectation,
  ): Promise<boolean> {
    let result: COS.HeadObjectResult;
    try {
      result = await this.createClient(config).headObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      });
    } catch (error) {
      const status = readCosStatusCode(error);
      if (status === 404) return false;
      if (status === 403) {
        throw new ForbiddenException('腾讯云 COS 拒绝读取对象元数据');
      }
      throw new ServiceUnavailableException('腾讯云 COS 对象存在性检查失败');
    }
    const metadata = this.readObjectMetadata(result.headers);
    const digest = result.headers?.['x-cos-meta-content-sha256'];
    if (
      result.headers?.['x-cos-meta-input-sha256'] !== expected.inputDigest ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      metadata.contentType !== expected.contentType ||
      (expected.contentSha256 !== undefined &&
        digest !== expected.contentSha256) ||
      (expected.contentLength !== undefined &&
        metadata.contentLength !== expected.contentLength)
    ) {
      throw new CosObjectWriteError(
        'OBJECT_CONFLICT',
        '腾讯云 COS 已有对象与本次渲染的输入或内容不一致',
      );
    }
    return true;
  }

  /**
   * 读取对象的真实元数据。
   * @param key 已登记的 COS 对象 key
   * @returns 返回 COS 实际 Content-Length 与 Content-Type
   * @description 聊天附件不能信任客户端登记的大小和 MIME；在创建任务前通过带服务端凭据的
   * HEAD 请求核对真实对象，避免伪造登记值绕过视觉输入上限。
   */
  async getObjectMetadata(key: string): Promise<CosObjectMetadata> {
    this.assertSafeKey(key);
    const config = this.requireConfig();
    let result: COS.HeadObjectResult;
    try {
      result = await this.createClient(config).headObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      });
    } catch {
      throw new ServiceUnavailableException('腾讯云 COS 对象元数据读取失败');
    }
    return this.readObjectMetadata(result.headers);
  }

  /**
   * 下载一个有明确字节上限的 COS 对象。
   * @param key 已登记的 COS 对象 key
   * @param maxBytes 允许读入内存的最大字节数
   * @returns 返回对象二进制与 COS 实际元数据
   * @description 先 HEAD 拒绝超限对象，再用 Range 多取一个字节作为竞态保护；即使对象在
   * HEAD 后被替换，也不会无界读入 Activity Worker 内存。
   */
  async downloadObject(
    key: string,
    maxBytes: number,
  ): Promise<CosDownloadedObject> {
    const metadata = await this.getObjectMetadata(key);
    if (metadata.contentLength > maxBytes) {
      throw new BadRequestException(`COS 对象不能超过 ${maxBytes} 字节`);
    }
    const config = this.requireConfig();
    let result: COS.GetObjectResult;
    try {
      result = await this.createClient(config).getObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Range: `bytes=0-${maxBytes}`,
      });
    } catch {
      throw new ServiceUnavailableException('腾讯云 COS 对象下载失败');
    }
    if (result.Body.length > maxBytes) {
      throw new BadRequestException(`COS 对象不能超过 ${maxBytes} 字节`);
    }
    return { body: result.Body, ...metadata };
  }

  /**
   * 生成 COS 对象 key
   * @param type 媒体类型，作为对象目录前缀
   * @param userId 上传者 ID，作为对象归属目录
   * @param ext 文件扩展名
   * @returns 返回格式为 {image|audio}/{yyyyMM}/{userId}/{uuid32}.{ext} 的对象 key
   * @description 按月和用户分层，随机 UUID 避免同名覆盖并便于对象生命周期治理。
   */
  private buildObjectKey(
    type: UploadMediaType,
    userId: string,
    ext: string,
  ): string {
    const now = new Date();
    const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const id = randomUUID().replaceAll('-', '');
    return `${type}/${month}/${userId}/${id}.${ext.toLowerCase()}`;
  }

  /**
   * 生成确定的上传 Content-Type
   * @param type 媒体类型
   * @param ext 文件扩展名
   * @returns 返回用于 COS 签名与小程序 PUT 请求的 MIME 类型
   * @description 仅允许媒体类型与扩展名的闭集组合，避免为未知或不匹配的文件签发上传地址。
   */
  private resolveContentType(type: UploadMediaType, ext: string): string {
    const contentType = CONTENT_TYPES[type][ext.toLowerCase()];
    if (!contentType) {
      throw new BadRequestException(
        `不支持的媒体扩展名：${type} 类型不支持 .${ext.toLowerCase()}`,
      );
    }

    return contentType;
  }

  /**
   * 使用官方 COS SDK 生成 HTTPS PUT 预签名 URL
   * @param config 已校验的 COS 配置
   * @param key 本次上传唯一允许写入的对象 key
   * @param headers 必须参与签名并由小程序原样携带的请求头
   * @returns 返回十分钟有效的 HTTPS PUT 预签名 URL
   * @description SDK 的 getObjectUrl 使用回调，本方法将其封装为 Promise，便于上层正确等待签名完成与处理错误。
   */
  private createSignedPutUrl(
    config: CosStorageConfig,
    key: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<string> {
    const client = new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
    });

    return new Promise((resolve, reject) => {
      client.getObjectUrl(
        {
          Bucket: config.bucket,
          Region: config.region,
          Key: key,
          Method: 'PUT',
          Sign: true,
          Expires: UPLOAD_URL_TTL_SECONDS,
          Protocol: 'https:',
          Headers: headers,
        },
        (error, data) => {
          if (error) {
            reject(
              new ServiceUnavailableException('腾讯云 COS 上传凭证签发失败'),
            );
            return;
          }

          if (!data.Url.startsWith('https://')) {
            reject(
              new ServiceUnavailableException(
                '腾讯云 COS 未返回 HTTPS 上传地址',
              ),
            );
            return;
          }

          resolve(data.Url);
        },
      );
    });
  }

  /** 使用已校验配置创建 COS SDK 客户端。 */
  private createClient(config: CosStorageConfig): COS {
    return new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
    });
  }

  /** 从 COS 响应头收窄出可信对象大小与 MIME。 */
  private readObjectMetadata(
    headers: COS.Headers | undefined,
  ): CosObjectMetadata {
    const contentLength = Number(headers?.['content-length']);
    const contentType = headers?.['content-type'];
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength <= 0 ||
      typeof contentType !== 'string' ||
      !contentType.trim()
    ) {
      throw new ServiceUnavailableException('腾讯云 COS 对象元数据不完整');
    }
    return {
      contentLength,
      contentType: contentType.split(';', 1)[0].trim().toLowerCase(),
    };
  }

  /**
   * 读取并校验 COS 配置
   * @returns 返回签发预签名 URL 所需的 COS 凭据、空间、区域和访问域名
   * @description 配置校验延迟到实际调用，缺失配置不会影响 API 启动，但所有对象存储操作都会明确失败。
   */
  private requireConfig(): CosStorageConfig {
    const secretId = this.configService.get<string>('COS_SECRET_ID');
    const secretKey = this.configService.get<string>('COS_SECRET_KEY');
    const bucket = this.configService.get<string>('COS_BUCKET');
    const region = this.configService.get<string>('COS_REGION');
    const rawDomain = this.configService.get<string>('COS_BUCKET_DOMAIN');

    if (
      !secretId?.trim() ||
      !secretKey?.trim() ||
      !bucket?.trim() ||
      !region?.trim() ||
      !rawDomain?.trim()
    ) {
      throw new ServiceUnavailableException(
        'COS 对象存储未配置：请在 env 中填写 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION / COS_BUCKET_DOMAIN',
      );
    }

    const normalizedBucket = bucket.trim();
    const normalizedRegion = region.trim();
    this.assertBucketAndRegion(normalizedBucket, normalizedRegion);

    return {
      secretId: secretId.trim(),
      secretKey: secretKey.trim(),
      bucket: normalizedBucket,
      region: normalizedRegion,
      domain: this.normalizeDomain(rawDomain),
    };
  }

  /**
   * 校验 COS 存储桶与区域格式
   * @param bucket COS bucket 名称，必须含 APPID 后缀
   * @param region COS 区域，必须使用 ap- 前缀
   * @returns 无返回值；格式不合法时抛出服务不可用异常
   * @description 在请求 SDK 签名之前拒绝错误配置，避免生成不能使用的上传地址。
   */
  private assertBucketAndRegion(bucket: string, region: string): void {
    if (!COS_BUCKET_PATTERN.test(bucket) || !COS_REGION_PATTERN.test(region)) {
      throw new ServiceUnavailableException(
        'COS 对象存储配置无效：COS_BUCKET 必须是含 -appid 后缀的小写 bucket 名，COS_REGION 必须形如 ap-guangzhou',
      );
    }
  }

  /**
   * 规范化 COS 对象访问域名
   * @param rawDomain 环境变量中的 CDN 或 COS 访问域名
   * @returns 返回不含路径、查询参数和尾部斜杠的 HTTP(S) 域名基址
   * @description 访问 URL 只允许由域名与服务端生成的 key 组成，避免环境配置中携带路径或凭据后改变对象访问路径。
   */
  private normalizeDomain(rawDomain: string): string {
    const candidate = rawDomain.trim();
    const value = /^https?:\/\//i.test(candidate)
      ? candidate
      : `https://${candidate}`;

    try {
      const url = new URL(value);
      const hasOnlyOrigin =
        /^\/+$/u.test(url.pathname) &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password;

      if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        !url.hostname ||
        !hasOnlyOrigin
      ) {
        throw new Error('invalid COS bucket domain');
      }

      return url.origin;
    } catch {
      throw new ServiceUnavailableException(
        'COS 对象存储配置无效：COS_BUCKET_DOMAIN 必须是纯 HTTP(S) 域名',
      );
    }
  }

  /**
   * 拼接安全的 COS 公有读地址
   * @param domain 已规范化的 COS 或 CDN 域名
   * @param key 对象 key
   * @returns 返回可直接访问的对象 URL
   * @description key 逐段保留目录结构并编码特殊字符，禁止相对路径、协议片段和绝对路径。
   */
  private buildAccessUrl(domain: string, key: string): string {
    this.assertSafeKey(key);
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return `${domain}/${encodedKey}`;
  }

  /**
   * 校验对象 key 不会改变访问域名或逃逸对象目录
   * @param key 待解析的对象 key
   * @returns 无返回值；非法 key 抛出请求错误
   */
  private assertSafeKey(key: string): void {
    if (
      !key ||
      key.includes('..') ||
      key.includes('://') ||
      key.startsWith('/')
    ) {
      throw new BadRequestException('非法的对象 key');
    }
  }
}

/**
 * 从 COS SDK 异常里读出 HTTP 状态码
 * @param error SDK 抛出的未知异常
 * @returns 能读出 4xx/5xx 时返回状态码，否则返回 undefined
 * @description SDK 的异常形状并不统一：常见形状是 `{ statusCode, error: { Code } }`，
 * 也有只把状态码放在 `error.error.statusCode` 的版本。读不出来时返回 undefined，让调用方按
 * 「未知故障」处理，而不是猜成 404 把一次网络故障当成「对象不存在」进而重复上传。
 */
function readCosStatusCode(error: unknown): number | undefined {
  const read = (value: unknown): number | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;
    const status = Reflect.get(value, 'statusCode');
    return typeof status === 'number' && Number.isInteger(status)
      ? status
      : undefined;
  };
  if (typeof error !== 'object' || error === null) return undefined;
  return read(error) ?? read(Reflect.get(error, 'error'));
}
