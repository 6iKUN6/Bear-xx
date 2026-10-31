import { Module } from '@nestjs/common';
import { HtmlRenderService } from './html-render.service';

/**
 * HTML → mp4 渲染模块
 * @description 只导出渲染服务；对象存储仍由 StorageModule 负责，这里不重复封装 COS。
 */
@Module({
  providers: [HtmlRenderService],
  exports: [HtmlRenderService],
})
export class HtmlRenderModule {}
