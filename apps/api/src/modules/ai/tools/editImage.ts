import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getTaskUserId } from '../telemetry/model-call-context';
import type { ImageGenerationService } from '../../images/image-generation.service';

/** 无任务上下文（理论上不发生）时资产的兜底归属目录 */
const SYSTEM_OWNER_ID = 'system';

/**
 * 创建参考图生图（改图）工具
 * @param imageGenerationService 生图管道服务
 * @returns 返回 LangChain 工具实例
 * @description 用户要求“基于某张图修改/换风格/局部调整”时使用：参考图 URL
 * 从对话上下文取（此前生成或用户提供的图片地址）。管道内含 SSRF 防护与
 * 大小限制，失败以稳定文本返回供模型转述。
 */
export function createEditImageTool(
  imageGenerationService: ImageGenerationService,
) {
  return tool(
    async (input: { prompt: string; imageUrls: string[]; size?: string }) => {
      try {
        const userId = getTaskUserId() ?? SYSTEM_OWNER_ID;
        const image = await imageGenerationService.edit(userId, {
          prompt: input.prompt,
          sourceUrls: input.imageUrls,
          size: input.size,
        });
        return [
          '图片已按参考图生成并保存。',
          `图片地址：${image.url}`,
          image.revisedPrompt ? `实际使用的提示词：${image.revisedPrompt}` : '',
          '请把图片以 markdown 形式 ![图片](URL) 回复给用户。',
        ]
          .filter(Boolean)
          .join('\n');
      } catch (error) {
        return `参考图生图失败：${error instanceof Error ? error.message : String(error)}。请把失败原因告知用户。`;
      }
    },
    {
      name: 'editImage',
      description:
        '基于 1-4 张参考图和文字描述生成新图片（改图/换风格/融合），参考图地址取对话中出现过的图片 URL。',
      schema: z.object({
        prompt: z
          .string()
          .min(1)
          .max(2000)
          .describe('修改要求描述，例如“把背景换成夜晚的城市”'),
        imageUrls: z
          .array(z.string().url())
          .min(1)
          .max(4)
          .describe('参考图完整 URL 列表（1-4 张），取对话中出现过的图片地址'),
        size: z
          .enum(['1024x1024', '1024x1536', '1536x1024'])
          .optional()
          .describe('输出尺寸：方图/竖图/横图，默认由模型决定'),
      }),
    },
  );
}
