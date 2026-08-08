/**
 * 载荷构造助手
 *
 * 绝大多数发射点不需要这里的函数：`StreamTaskWireEvent` 是判别联合，
 * 直接写对象字面量就会被完整检查（多字段 / 少字段 / 类型错都报错）。
 *
 * 本文件只服务于一种场景——**载荷由辅助函数构造后以变量形式传入**。
 * TypeScript 的多余属性检查只作用于对象字面量，不作用于变量，此时
 * 字面量的保护会失效，需要在构造处显式绑定事件类型。
 *
 * 例：`AgentLoopController.buildStepPayload()` 返回对象再交给 stepStart/stepDone。
 */

import type { StreamTaskPayloadMap } from './payloads.js';

/**
 * 构造指定事件的载荷
 * @param _type 事件类型（仅用于绑定载荷类型，运行时不使用）
 * @param payload 载荷
 * @returns 原样返回载荷
 * @description 恒等函数，零运行时开销；作用是强制构造点声明事件类型，
 * 使类型与载荷不匹配在编译期暴露。
 */
export function createStreamPayload<K extends keyof StreamTaskPayloadMap>(
  _type: K,
  payload: StreamTaskPayloadMap[K],
): StreamTaskPayloadMap[K] {
  return payload;
}
