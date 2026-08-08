/**
 * 前后端共享的流式通讯协议契约
 *
 * 唯一事实源：后端 StreamTask 与前端 SSE 消费都从这里引入事件类型、载荷契约与中文文案，
 * 避免两侧各写一份导致漂移。
 *
 * 边界：只有**跨线传输**的东西进本目录。判据是「这个类型的字段会不会出现在 SSE 帧
 * 或 trace 行里」——不会就留在各自的 app 内，不要图方便塞进来。
 *
 * - `events.ts`     事件类型、终态集、信封、中文文案
 * - `payloads.ts`   各事件的线上载荷契约与映射表
 * - `factory.ts`    载荷构造助手（仅用于变量形式构造的场景）
 * - `strategy.ts`   执行策略闭集与中文名
 * - `approval-card.ts` 结构化审批卡（设计完成，尚未接线）
 */

export * from './events.js';
export * from './payloads.js';
export * from './factory.js';
export * from './strategy.js';
export * from './approval-card.js';

/**
 * 人工审批决定（前端提交、后端恢复时消费）
 * @description approve 直接执行；reject 跳过并回注拒绝；edit 用 editedArgs 替换入参后执行。
 */
export interface ApprovalDecision {
  decision: import('./approval-card.js').ApprovalDecisionType;
  /** edit 时的新入参 */
  editedArgs?: Record<string, unknown>;
  /** reject 时可选的说明 */
  reason?: string;
}
