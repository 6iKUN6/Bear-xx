import { createHash } from 'node:crypto';

/**
 * 渲染产物的对象存储 key
 * @description 成片 key 必须由 `taskId` 与 `nodeExecutionId` **唯一确定**，不能掺入时间戳、
 * 随机数或月份目录：Activity 重试时要能凭同一组标识算出同一个 key，才能先查存在性再决定
 * 是否重渲染。掺入日期后跨月重试会算出第二个 key，幂等保证立刻失效。
 *
 * `nodeExecutionId` 里含轮次段（形如 `taskId:nodeKey#0`），因此「同一轮重试复用同一 key、
 * 下一轮用新 key」是自然结果，不需要额外传轮次。
 */
export interface RenderVideoObjectInput {
  /** 任务创建时持久化的测试标记；测试成片仅写入 dev 目录。 */
  isTest: boolean;
  /** 任务标识 */
  taskId: string;
  /** 节点执行标识，已包含循环轮次 */
  nodeExecutionId: string;
}

/** 对象 key 里允许出现的字符；其余字符一律折叠为 `-`。 */
const KEY_SEGMENT_UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * 生成一次渲染的稳定成片 key
 * @param input 任务标识与节点执行标识
 * @returns 测试任务返回 `dev/video/{taskId}/{摘要}.mp4`，普通任务返回 `video/{taskId}/{摘要}.mp4`
 * @description 可读目录只用于定位，唯一性由未截断的 taskId 与 nodeExecutionId 的 SHA-256 保证。
 * 目录隔离使用任务持久化的 isTest，不受 Worker 重启或部署环境变量变化影响。
 * 原实现把执行标识截到 128 字符，合法的 64 字符节点名会挤掉末尾轮次，导致下一轮复用旧成片。
 * JSON 元组保留标识边界，也避免分隔符折叠后让两个不同执行标识共用同一对象。
 */
export function buildRenderVideoObjectKey(
  input: RenderVideoObjectInput,
): string {
  const taskId = sanitizeKeySegment(input.taskId);
  const nodeExecutionId = sanitizeKeySegment(input.nodeExecutionId);
  if (!taskId || !nodeExecutionId) {
    throw new Error('渲染对象 key 的任务标识或节点执行标识为空');
  }
  const identityDigest = createHash('sha256')
    .update(JSON.stringify([input.taskId, input.nodeExecutionId]))
    .digest('hex');
  return `${input.isTest ? 'dev/' : ''}video/${taskId}/${identityDigest}.mp4`;
}

/**
 * 把标识收窄成对象 key 的安全片段
 * @param value 原始标识
 * @returns 返回仅含 `[A-Za-z0-9._-]` 的片段
 * @description 同时挡住 `..`、`/` 与协议片段，避免标识影响对象目录结构。
 */
function sanitizeKeySegment(value: string): string {
  return value
    .trim()
    .replace(KEY_SEGMENT_UNSAFE, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 128);
}
