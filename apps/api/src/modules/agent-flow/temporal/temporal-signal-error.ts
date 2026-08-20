import { WorkflowNotFoundError } from '@temporalio/client';

/**
 * 判断 Signal 目标 Workflow 是否已不可达
 * @param error Temporal Client 抛出的未知错误
 * @returns 目标 Workflow 已关闭或不存在时返回 true
 * @description 审批 outbox 与取消补偿都面对同一竞态：决定或取消落库的瞬间，目标
 * Workflow 可能刚因超时、完成或人工终止而关闭，此后 Signal 永远送不到。这类错误必须
 * 判定为终态，否则记录会以最旧时间戳长期占满派发批次，把后续新记录饿死。
 */
export function isWorkflowUnreachableError(error: unknown): boolean {
  if (error instanceof WorkflowNotFoundError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('workflow execution already completed') ||
    message.includes('workflow not found') ||
    message.includes('not found')
  );
}
