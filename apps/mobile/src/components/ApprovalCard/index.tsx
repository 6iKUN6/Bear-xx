import { memo, useState } from "react";
import { Text, Textarea, View } from "@tarojs/components";
import type {
  ApprovalDecision,
  ApprovalRequiredPayload,
} from "@litter-bear/types/protocol";
import "./index.scss";

interface ApprovalCardProps {
  /** 后端 approval.required 事件载荷 */
  payload: ApprovalRequiredPayload;
  /** 提交中（恢复请求发起后禁用交互，避免重复提交） */
  submitting?: boolean;
  /** 已决策（历史卡片，只读展示） */
  resolved?: boolean;
  /** 提交人工决定 */
  onDecision?: (decision: ApprovalDecision) => void;
}

/**
 * 工具级人工审批卡片（HITL）
 * @description 展示待审批的工具调用（名称/参数/说明），提供 通过 / 修改 / 拒绝 三态操作。
 * 纯展示组件：决定通过 onDecision 上抛，由上层调用 /approval 端点恢复续跑。
 */
function ApprovalCard({
  payload,
  submitting = false,
  resolved = false,
  onDecision,
}: ApprovalCardProps) {
  const allowed = payload.allowedDecisions ?? ["approve", "reject"];
  const canApprove = allowed.includes("approve");
  const canReject = allowed.includes("reject");
  const canEdit = allowed.includes("edit");

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(() => formatArgs(payload.args));
  const [parseError, setParseError] = useState<string | null>(null);

  const disabled = submitting || resolved;

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
        <Text className='at-icon at-icon-alert-circle approval-card-icon' />
        <Text className='approval-card-title'>
          {resolved ? "已处理的人工审批" : "待人工确认"}
        </Text>
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
        <View className='approval-card-args'>
          <Text className='approval-card-args-label'>调用参数</Text>
          <Text className='approval-card-args-code'>
            {formatArgs(payload.args) || "（无参数）"}
          </Text>
        </View>
      )}

      {!resolved && (
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
                  setEditText(formatArgs(payload.args));
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
      )}
    </View>
  );
}

/**
 * 格式化工具参数为易读 JSON
 * @param args 序列化后的参数字符串
 * @returns 美化后的 JSON 文本；非法则原样返回
 */
function formatArgs(args?: string): string {
  if (!args) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

export default memo(ApprovalCard);
