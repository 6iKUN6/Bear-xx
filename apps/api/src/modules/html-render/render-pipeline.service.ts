import { Injectable } from '@nestjs/common';
import { openAsBlob } from 'node:fs';
import type {
  CosObjectExecution,
  CosStorageService,
} from '../storage/cos-storage.service';
import { HtmlRenderService } from './html-render.service';
import { buildRenderVideoObjectKey } from './render-object-key';

/** 一次渲染编排的入参。 */
export interface RenderPipelineInput {
  /** 待渲染的完整 HTML 文档。 */
  html: string;
  /** 视口与成片宽度（像素，偶数）。 */
  width: number;
  /** 视口与成片高度（像素，偶数）。 */
  height: number;
  /** 成片时长（秒）。 */
  durationSeconds: number;
  /** 成片帧率。 */
  fps: number;
  /** 幂等身份：由调用方确定，重试与恢复复用同一成片。 */
  execution: CosObjectExecution;
  /** 内容摘要，参与 COS 幂等校验。 */
  inputDigest: string;
  /** 取消信号；触发后停掉浏览器与 ffmpeg 并清理临时目录。 */
  signal?: AbortSignal;
  /** 每帧截取后的进度回调；调用方用它发心跳。 */
  onFrame?: (progress: {
    frame: number;
    totalFrames: number;
  }) => void | Promise<void>;
}

/** 一次渲染编排的结果。 */
export interface RenderPipelineResult {
  /** 成片在对象存储上的 key。 */
  key: string;
  /** 是否由本次调用真正渲染并上传；false 表示复用已有成片。 */
  created: boolean;
  /** 实际渲染帧数；复用已有成片时为 0。 */
  frameCount: number;
}

/**
 * 渲染执行编排服务
 * @description 承担「HTML → 渲染 → 幂等上传 → 成片 key」的完整编排，是 render 节点与
 * 渲染工具共享的唯一实现。不负责 HTML 来源解析与执行身份决策——这两者由调用方
 * （render 节点 / 渲染工具）确定后显式传入，避免节点与工具各维护一份编排逻辑导致
 * 幂等语义、取消释放与错误归类漂移。
 */
@Injectable()
export class RenderPipelineService {
  constructor(
    private readonly htmlRenderService: HtmlRenderService,
    private readonly cosStorageService: CosStorageService,
  ) {}

  /**
   * 把一段 HTML 渲染成视频并落到对象存储
   * @param input 渲染参数、幂等身份、内容摘要与可选取消/进度回调
   * @returns 返回成片 key、是否本次新建与帧数
   * @description 先按内容摘要做幂等存在性检查，命中直接复用；否则渲染、上传，最后释放临时目录。
   */
  async renderToObject(
    input: RenderPipelineInput,
  ): Promise<RenderPipelineResult> {
    const objectKey = buildRenderVideoObjectKey(input.execution);
    input.signal?.throwIfAborted();
    if (
      await this.cosStorageService.objectExists(objectKey, {
        execution: input.execution,
        inputDigest: input.inputDigest,
        contentType: 'video/mp4',
      })
    ) {
      return { key: objectKey, created: false, frameCount: 0 };
    }
    input.signal?.throwIfAborted();
    const rendered = await this.htmlRenderService.render({
      html: input.html,
      width: input.width,
      height: input.height,
      durationSeconds: input.durationSeconds,
      fps: input.fps,
      signal: input.signal,
      onFrame: input.onFrame,
    });
    try {
      input.signal?.throwIfAborted();
      const data = await openAsBlob(rendered.filePath);
      const uploaded = await this.cosStorageService.putObjectIfAbsent({
        key: objectKey,
        execution: input.execution,
        data,
        inputDigest: input.inputDigest,
        contentType: 'video/mp4',
        signal: input.signal,
      });
      return {
        key: uploaded.key,
        created: uploaded.created,
        frameCount: rendered.frameCount,
      };
    } finally {
      await rendered.dispose();
    }
  }
}
