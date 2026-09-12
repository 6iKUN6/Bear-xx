import { memo, useState } from "react";
import { Text, Textarea, View } from "@tarojs/components";
import AppIcon from "../AppIcon";
import {
  APPROVAL_DECISION_LABELS,
  type ApprovalDecision,
  type ApprovalDecisionType,
  type ApprovalRequiredPayload,
} from "@litter-bear/types/protocol";
import {
  formatApprovalArgs,
  splitApprovalArgs,
} from "@litter-bear/chat-core";
import "./index.scss";

interface ApprovalCardProps {
  /** 后端 approval.required 事件载荷 */
  payload: ApprovalRequiredPayload;
  /** 提交中（恢复请求发起后禁用交互，避免重复提交） */
  submitting?: boolean;
  /** 已决策（历史卡片，只读展示） */
  resolved?: boolean;
  /** 已做出的决定（resolved 时用于单行结论文案与成败色） */
  resolvedDecision?: ApprovalDecisionType;
  /** 提交人工决定 */
  onDecision?: (decision: ApprovalDecision) => void;
}

/**
 * 工具级人工审批卡片（HITL）
 * @description 待审批时展示工具名/说明/参数事实行，提供 通过 / 修改 / 拒绝 三态；
 * 嵌套与长文本参数收进「查看调用参数」折叠区，已处理的历史卡收敛为一行结论。
 * 纯展示组件：决定通过 onDecision 上抛，由上层调用 /approval 端点恢复续跑。
 */
function ApprovalCard({
  payload,
  submitting = false,
  resolved = false,
  resolvedDecision,
  onDecision,
}: ApprovalCardProps) {
  const allowed = payload.allowedDecisions ?? ["approve", "reject"];
  const canApprove = allowed.includes("approve");
  const canReject = allowed.includes("reject");
  const canEdit = allowed.includes("edit");

  const [editing, setEditing] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [editText, setEditText] = useState(() => formatApprovalArgs(payload.args));
  const [parseError, setParseError] = useState<string | null>(null);

  const disabled = submitting || resolved;

  // 已处理：整张卡收敛为一行结论
  if (resolved) {
    return (
      <ResolvedLine
        toolName={payload.toolName}
        decision={resolvedDecision}
      />
    );
  }

  const { facts, rawText } = splitApprovalArgs(payload.args);

  const emit = (decision: ApprovalDecision) => {
    if (disabled) {
      return;
    }
    onDecision?.(decision);
  };

  const handleConfirmEdit = () => {
    if (disabled) {
      return;
    }
    try {
      const editedArgs = editText.trim()
        ? (JSON.parse(editText) as Record<string, unknown>)
        : {};
      setParseError(null);
      onDecision?.({ decision: "edit", editedArgs });
    } catch {
      setParseError("参数不是合法的 JSON");
    }
  };

  return (
    <View className='approval-card'>
      <View className='approval-card-head'>
        <Text className='approval-card-badge'>!</Text>
        <Text className='approval-card-title'>待人工确认</Text>
        {payload.toolName && (
          <Text className='approval-card-tool'>{payload.toolName}</Text>
        )}
      </View>

      {payload.description && (
        <Text className='approval-card-desc'>{payload.description}</Text>
      )}

      {editing ? (
        <View className='approval-card-editor'>
          <Textarea
            className='approval-card-textarea'
            value={editText}
            disabled={disabled}
            autoHeight
            placeholder='编辑工具参数（JSON）'
            onInput={(e) => setEditText(e.detail.value)}
          />
          {parseError && (
            <Text className='approval-card-error'>{parseError}</Text>
          )}
        </View>
      ) : (
        <>
          {facts.length > 0 && (
            <View className='approval-card-facts'>
              {facts.map((fact) => (
                <View key={fact.key} className='approval-fact'>
                  <Text className='approval-fact-key'>{fact.key}</Text>
                  <Text className='approval-fact-value'>{fact.value}</Text>
                </View>
              ))}
            </View>
          )}

          {rawText && (
            <View>
              <View
                className='approval-raw-toggle'
                onClick={() => setShowRaw((v) => !v)}
              >
                <Text
                  className={`approval-raw-caret ${showRaw ? "approval-raw-caret-open" : ""}`}
                >
                  ▸
                </Text>
                <Text>{showRaw ? "收起调用参数" : "查看调用参数"}</Text>
              </View>
              {showRaw && (
                <Text className='approval-raw-code'>{rawText}</Text>
              )}
            </View>
          )}
        </>
      )}

      <View className='approval-card-actions'>
        {editing ? (
          <>
            <View
              className={`approval-btn approval-btn-primary ${disabled ? "approval-btn-disabled" : ""}`}
              onClick={handleConfirmEdit}
            >
              <Text>确认修改并执行</Text>
            </View>
            <View
              className='approval-btn approval-btn-ghost'
              onClick={() => {
                setEditing(false);
                setParseError(null);
                setEditText(formatApprovalArgs(payload.args));
              }}
            >
              <Text>取消</Text>
            </View>
          </>
        ) : (
          <>
            {canApprove && (
              <View
                className={`approval-btn approval-btn-primary ${disabled ? "approval-btn-disabled" : ""}`}
                onClick={() => emit({ decision: "approve" })}
              >
                <Text>{submitting ? "处理中…" : "通过"}</Text>
              </View>
            )}
            {canEdit && (
              <View
                className={`approval-btn approval-btn-ghost ${disabled ? "approval-btn-disabled" : ""}`}
                onClick={() => !disabled && setEditing(true)}
              >
                <Text>修改参数</Text>
              </View>
            )}
            {canReject && (
              <View
                className={`approval-btn approval-btn-danger ${disabled ? "approval-btn-disabled" : ""}`}
                onClick={() => emit({ decision: "reject" })}
              >
                <Text>拒绝</Text>
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
}

/**
 * 已处理审批的一行结论
 * @param toolName 工具名
 * @param decision 已做出的决定；缺省按 approve 处理
 */
function ResolvedLine({
  toolName,
  decision = "approve",
}: {
  toolName?: string;
  decision?: ApprovalDecisionType;
}) {
  const rejected = decision === "reject";
  return (
    <View
      className={`approval-resolved ${rejected ? "approval-resolved-no" : "approval-resolved-ok"}`}
    >
      <AppIcon
        name={rejected ? "close" : "check"}
        className='approval-resolved-ico h-[0.875rem] w-[0.875rem]'
      />
      <Text>
        {APPROVAL_DECISION_LABELS[decision]}
        {toolName ? ` · ${toolName}` : ""}
      </Text>
    </View>
  );
}

export default memo(ApprovalCard);
