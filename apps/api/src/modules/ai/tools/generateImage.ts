import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getTaskUserId } from '../telemetry/model-call-context';
import type { ImageGenerationService } from '../../images/image-generation.service';

/** 无任务上下文（理论上不发生）时资产的兜底归属目录 */
const SYSTEM_OWNER_ID = 'system';

/**
 * 创建 AI 生图工具（文生图 + 参考图生图合一）
 * @param imageGenerationService 生图管道服务
 * @returns 返回 LangChain 工具实例
 * @description 单一工具按参数区分两种场景：不传 imageUrls 即文生图；传 1-4 张
 * 参考图 URL 即基于参考图生成（改图/换风格/融合），参考图地址取对话中出现过的图片 URL。
 * 生图依赖服务注入，由 CapabilityRegistry 构造时经此工厂创建。资产归属用户从任务
 * 执行上下文（ALS）读取。返回给模型的是稳定中文文本 + 图片 URL，由模型以 markdown
 * ![图片](URL) 转述给用户（前端消息里可直接渲染）。
 */
export function createGenerateImageTool(
  imageGenerationService: ImageGenerationService,
) {
  return tool(
    async (input: { prompt: string; imageUrls?: string[]; size?: string }) => {
      const hasReferences = (input.imageUrls?.length ?? 0) > 0;
      try {
        const userId = getTaskUserId() ?? SYSTEM_OWNER_ID;
        const image = hasReferences
          ? await imageGenerationService.edit(userId, {
              prompt: input.prompt,
              sourceUrls: input.imageUrls,
              size: input.size,
            })
          : await imageGenerationService.generate(
              userId,
              input.prompt,
              input.size,
            );
        return [
          hasReferences ? '图片已按参考图生成并保存。' : '图片已生成并保存。',
          `图片地址：${image.url}`,
          image.revisedPrompt ? `实际使用的提示词：${image.revisedPrompt}` : '',
          '请把图片以 markdown 形式 ![图片](URL) 回复给用户。',
        ]
          .filter(Boolean)
          .join('\n');
      } catch (error) {
        return `生图失败：${error instanceof Error ? error.message : String(error)}。请把失败原因告知用户。`;
      }
    },
    {
      name: 'generateImage',
      description:
        '生成图片并返回图片地址。文生图：只给文字描述即可（画图/插画/海报/头像等）；' +
        '参考图生图：额外提供 1-4 张参考图 URL（取对话中出现过的图片地址）即可改图/换风格/融合。',
      schema: z.object({
        prompt: z
          .string()
          .min(1)
          .max(2000)
          .describe(
            '图片内容或修改要求描述，越具体效果越好（主体、风格、构图、光线）',
          ),
        imageUrls: z
          .array(z.string().url())
          .min(1)
          .max(4)
          .optional()
          .describe(
            '可选参考图 URL 列表（1-4 张）：提供则基于参考图生成，取对话中出现过的图片地址；不提供则文生图',
          ),
        size: z
          .enum(['1024x1024', '1024x1536', '1536x1024'])
          .optional()
          .describe('图片尺寸：方图/竖图/横图，默认由模型决定'),
      }),
    },
  );
}
