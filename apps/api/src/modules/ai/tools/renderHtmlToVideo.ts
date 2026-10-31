import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { FLOW_RENDER_LIMITS } from '@litter-bear/types/agent-flow';
import { getTaskId, getTaskIsTest } from '../telemetry/model-call-context';
import type { HtmlRenderService } from '../../html-render/html-render.service';
import { buildRenderVideoObjectKey } from '../../html-render/render-object-key';
import type {
  CosObjectExecution,
  CosStorageService,
} from '../../storage/cos-storage.service';

/** 渲染工具的运行时名称；同时作为 COS 幂等身份的 nodeKey。 */
const RENDER_TOOL_NAME = 'renderHtmlToVideo';

/** 一次渲染工具调用的参数。 */
interface RenderToolInput {
  html: string;
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
}

/**
 * 创建 HTML 渲染成片工具
 * @param htmlRenderService HTML → mp4 渲染服务
 * @param cosStorageService 对象存储服务，负责幂等上传与复用
 * @returns 返回 LangChain 工具实例
 * @description 让 agent 在工具循环里把一段 HTML 渲染成竖屏/横屏视频并拿回成片地址。
 * 幂等用内容寻址：html 与四个渲染参数共同确定一个稳定 key，同样的请求复用同一成片，
 * 不依赖节点执行身份。成片地址由工具真实返回，不信任模型复述的路径。
 */
export function createRenderHtmlToVideoTool(
  htmlRenderService: HtmlRenderService,
  cosStorageService: CosStorageService,
) {
  return tool(
    async (input: RenderToolInput) => {
      const taskId = getTaskId();
      if (!taskId) {
        return '渲染失败：缺少任务上下文，无法确定成片归属。';
      }
      if (
        Buffer.byteLength(input.html, 'utf8') > FLOW_RENDER_LIMITS.maxHtmlBytes
      ) {
        return '渲染失败：待渲染的 HTML 超过体积上限。';
      }
      const isTest = getTaskIsTest() ?? false;
      // 内容寻址：html 与四个渲染参数共同确定成片身份，重试与恢复复用同一对象。
      const inputDigest = createHash('sha256')
        .update(
          JSON.stringify([
            input.html,
            input.width,
            input.height,
            input.durationSeconds,
            input.fps,
          ]),
        )
        .digest('hex');
      const execution: CosObjectExecution = {
        taskId,
        nodeExecutionId: inputDigest,
        nodeKey: RENDER_TOOL_NAME,
        isTest,
      };
      const objectKey = buildRenderVideoObjectKey(execution);
      try {
        if (
          await cosStorageService.objectExists(objectKey, {
            execution,
            inputDigest,
            contentType: 'video/mp4',
          })
        ) {
          return `成片已存在，复用已有渲染结果。成片地址：${objectKey}`;
        }
        const rendered = await htmlRenderService.render({
          html: input.html,
          width: input.width,
          height: input.height,
          durationSeconds: input.durationSeconds,
          fps: input.fps,
        });
        try {
          const data = await openAsBlob(rendered.filePath);
          const uploaded = await cosStorageService.putObjectIfAbsent({
            key: objectKey,
            execution,
            data,
            inputDigest,
            contentType: 'video/mp4',
          });
          return `已渲染 ${rendered.frameCount} 帧成片。成片地址：${uploaded.key}`;
        } finally {
          await rendered.dispose();
        }
      } catch (error) {
        return `渲染失败：${error instanceof Error ? error.message : String(error)}。请把失败原因告知用户。`;
      }
    },
    {
      name: RENDER_TOOL_NAME,
      description:
        '把一段 HTML 渲染成视频并返回成片地址。适用竖屏 1080×1920 或横屏视频：' +
        '传入完整 HTML 文档（需暴露 window.renderFrame(timeSeconds) 时间推进接口），' +
        '并指定宽高（必须为偶数）、时长秒数与帧率。',
      schema: z.object({
        html: z
          .string()
          .min(1)
          .describe(
            '要渲染的完整 HTML 文档，需暴露 window.renderFrame(timeSeconds) 供逐帧推进画面',
          ),
        width: z
          .number()
          .int()
          .min(FLOW_RENDER_LIMITS.minWidth)
          .max(FLOW_RENDER_LIMITS.maxWidth)
          .refine((value) => value % 2 === 0, { message: '宽度必须是偶数' })
          .describe('成片宽度（像素，偶数）'),
        height: z
          .number()
          .int()
          .min(FLOW_RENDER_LIMITS.minHeight)
          .max(FLOW_RENDER_LIMITS.maxHeight)
          .refine((value) => value % 2 === 0, { message: '高度必须是偶数' })
          .describe('成片高度（像素，偶数）'),
        durationSeconds: z
          .number()
          .int()
          .min(FLOW_RENDER_LIMITS.minDurationSeconds)
          .max(FLOW_RENDER_LIMITS.maxDurationSeconds)
          .describe('成片时长（秒）'),
        fps: z
          .number()
          .int()
          .min(FLOW_RENDER_LIMITS.minFps)
          .max(FLOW_RENDER_LIMITS.maxFps)
          .describe('成片帧率'),
      }),
    },
  );
}
