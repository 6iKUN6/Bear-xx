import { memo, useState } from "react";
import { Text, Textarea, View } from "@tarojs/components";
import type {
  PlanReviewDecision,
  PlanReviewRequiredPayload,
} from "@litter-bear/types/protocol";
import "./index.scss";

interface PlanReviewCardProps {
  /** 后端 plan.review.required 事件载荷 */
  payload: PlanReviewRequiredPayload;
  /** 提交中（恢复请求发起后禁用交互，避免重复提交） */
  submitting?: boolean;
  /** 已决策（历史卡片，只读展示） */
  resolved?: boolean;
  /** 提交计划审批决定 */
  onDecision?: (decision: PlanReviewDecision) => void;
}

/**
 * 计划审批卡片（plan_execute HITL）
 * @description 出计划后、执行前展示可确认的步骤清单：可改每步文字、可末尾追加步骤，
 * 提供 通过 / 打回重规划 / 终止 三态操作。改过任一步或追加后，「通过」变为「确认修改并执行」（edit）。
 * 纯展示组件：决定通过 onDecision 上抛，由上层调用 /plan-review 端点恢复续跑。
 */
function PlanReviewCard({
  payload,
  submitting = false,
  resolved = false,
  onDecision,
}: PlanReviewCardProps) {
  const allowed = payload.allowedDecisions ?? [
    "approve",
    "edit",
    "reject_replan",
    "reject_terminate",
  ];
  const canApprove = allowed.includes("approve");
  const canReplan = allowed.includes("reject_replan");
  const canTerminate = allowed.includes("reject_terminate");

  const original = payload.steps.map((step) => step.goal);
  const [goals, setGoals] = useState<string[]>(original);
  const [replanning, setReplanning] = useState(false);
  const [feedback, setFeedback] = useState("");

  const disabled = submitting || resolved;
  // 改过任一步文字、或追加/删空了步骤，即视为编辑
  const dirty =
    goals.length !== original.length ||
    goals.some((goal, index) => goal !== original[index]);

  const updateGoal = (index: number, value: string) => {
    setGoals((prev) => prev.map((goal, i) => (i === index ? value : goal)));
  };

  const appendStep = () => {
    if (disabled) return;
    setGoals((prev) => [...prev, ""]);
  };

  const handlePrimary = () => {
    if (disabled) return;
    if (!dirty) {
      onDecision?.({ decision: "approve" });
      return;
    }
    const editedSteps = goals
      .map((goal) => goal.trim())
      .filter((goal) => goal.length > 0)
      .map((goal) => ({ goal }));
    onDecision?.({ decision: "edit", editedSteps });
  };

  const handleReplan = () => {
    if (disabled) return;
    onDecision?.({ decision: "reject_replan", feedback: feedback.trim() });
  };

  return (
    <View className='plan-review-card'>
      <View className='plan-review-card-head'>
        <Text className='at-icon at-icon-list plan-review-card-icon' />
        <Text className='plan-review-card-title'>
          {resolved ? "已处理的计划确认" : "待确认执行计划"}
        </Text>
        {payload.revision > 0 && (
          <Text className='plan-review-card-badge'>
            第 {payload.revision + 1} 版
          </Text>
        )}
      </View>

      <View className='plan-review-card-steps'>
        {goals.map((goal, index) => (
          <View className='plan-review-card-step' key={index}>
            <Text className='plan-review-card-step-index'>{index + 1}</Text>
            {resolved ? (
              <Text className='plan-review-card-step-text'>{goal}</Text>
            ) : (
              <Textarea
                className='plan-review-card-step-input'
                value={goal}
                disabled={disabled}
                autoHeight
                placeholder='步骤目标'
                onInput={(e) => updateGoal(index, e.detail.value)}
              />
            )}
          </View>
        ))}
      </View>

      {!resolved && (
        <>
          <View className='plan-review-card-append' onClick={appendStep}>
            <Text>+ 追加一步</Text>
          </View>

          {replanning && (
            <Textarea
              className='plan-review-card-feedback'
              value={feedback}
              disabled={disabled}
              autoHeight
              placeholder='说说哪里要调整，让它重新规划（可留空）'
              onInput={(e) => setFeedback(e.detail.value)}
            />
          )}

          <View className='plan-review-card-actions'>
            {replanning ? (
              <>
                <View
                  className={`plan-review-btn plan-review-btn-primary ${disabled ? "plan-review-btn-disabled" : ""}`}
                  onClick={handleReplan}
                >
                  <Text>{submitting ? "处理中…" : "提交打回"}</Text>
                </View>
                <View
                  className='plan-review-btn plan-review-btn-ghost'
                  onClick={() => {
                    setReplanning(false);
                    setFeedback("");
                  }}
                >
                  <Text>取消</Text>
                </View>
              </>
            ) : (
              <>
                {canApprove && (
                  <View
                    className={`plan-review-btn plan-review-btn-primary ${disabled ? "plan-review-btn-disabled" : ""}`}
                    onClick={handlePrimary}
                  >
                    <Text>
                      {submitting
                        ? "处理中…"
                        : dirty
                          ? "确认修改并执行"
                          : "通过"}
                    </Text>
                  </View>
                )}
                {canReplan && (
                  <View
                    className={`plan-review-btn plan-review-btn-ghost ${disabled ? "plan-review-btn-disabled" : ""}`}
                    onClick={() => !disabled && setReplanning(true)}
                  >
                    <Text>打回重规划</Text>
                  </View>
                )}
                {canTerminate && (
                  <View
                    className={`plan-review-btn plan-review-btn-danger ${disabled ? "plan-review-btn-disabled" : ""}`}
                    onClick={() =>
                      !disabled &&
                      onDecision?.({ decision: "reject_terminate" })
                    }
                  >
                    <Text>终止</Text>
                  </View>
                )}
              </>
            )}
          </View>
        </>
      )}
    </View>
  );
}

export default memo(PlanReviewCard);
