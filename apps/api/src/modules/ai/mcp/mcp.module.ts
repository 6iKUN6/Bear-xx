import { Module } from '@nestjs/common';
import { McpClientManager } from './mcp-client-manager.service';

/** MCP 连接与审核工具缓存模块。 */
@Module({
  providers: [McpClientManager],
  exports: [McpClientManager],
})
export class McpModule {}
