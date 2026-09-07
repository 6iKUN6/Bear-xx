import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import Taro from "@tarojs/taro";
import { Image, View, Text, Textarea } from "@tarojs/components";
import AgentAvatar from "../AgentAvatar";
import AppIcon from "../AppIcon";
import type { AppIconName } from "../AppIcon";
import IconButton from "../IconButton";
import VoiceButton from "../VoiceButton";
import AgentSheet from "../AgentSheet";
import ModelSelectionSheet from "../ModelSelectionSheet";
import { useAgentStore } from "../../store/agentStore";
import { useAgentModelSelection } from "../../hooks/useAgentModelSelection";
import {
  findAgent,
  resolveAgentName,
  resolveOutgoingAgentId,
  type ChatAgentSelectionMode,
} from "../../utils/agent";
import { safeAreaBottom } from "../../utils/style";
import type { AgentSummary } from "../../api/agents";
import {
  isReasoningConfigurable,
  modelSelectionFingerprint,
  type AgentModelSelection,
} from "../../services/agent-model-selection";
import {
  prepareChatImage,
  uploadChatImage,
  type PreparedChatImage,
  type UploadedChatImage,
} from "../../utils/chat-image";

export type ChatImageAttachment = UploadedChatImage;

/** 供外部（成员条/开场提示等）操控输入框 */
export interface ChatInputHandle {
  insertMention: (agent: AgentSummary) => void;
  /** 把文本填进输入框（不发送） */
  setDraft: (text: string) => void;
}

/**
 * 输入栏模式：
 * - single：单聊（无胶囊/无 @，回答者由后端按会话绑定解析）
 * - group：群聊（无粘性胶囊，仅 @ 提及；不 @ 则后端自动路由）
 * - flex：未定型会话（本地草稿/旧数据），保留粘性胶囊 + 全量 @
 */
export type ChatInputMode = ChatAgentSelectionMode;

interface ChatInputProps {
  /** agentId：本条消息的回答者；undefined = 交给后端（绑定/路由/默认） */
  onSend: (
    content: string,
    agentId?: string,
    modelSelection?: AgentModelSelection,
    image?: ChatImageAttachment,
  ) => void;
  onStop?: () => void;
  onRecordComplete?: (
    filePath: string,
    agentId?: string,
    modelSelection?: AgentModelSelection,
  ) => void;
  isStreaming?: boolean;
  disabled?: boolean;
  /** 底部是否预留 safe-area（上方另有固定栏占位时传 false 避免双重留白） */
  reserveSafeArea?: boolean;
  mode?: ChatInputMode;
  /** @ 提及候选（群聊=成员列表）；缺省用全部智能体 */
  mentionAgents?: AgentSummary[];
  /** 当前会话已明确绑定的 Agent；群聊自动路由时不传 */
  modelAgentId?: string;
  /** 上一轮已发送配置，用于给出不阻断的新会话建议 */
  lastModelSelectionFingerprint?: string;
  placeholder?: string;
}

/** 一次性 @ 提及：仅对下一条消息生效 */
interface MentionTarget {
  /** 显式提及必须保留智能体真实 id（包括默认智能体）。 */
  agentId: string;
  name: string;
}

export default forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    onSend,
    onStop,
    onRecordComplete,
    isStreaming = false,
    disabled = false,
    reserveSafeArea = true,
    mode = "flex",
    mentionAgents,
    modelAgentId,
    lastModelSelectionFingerprint,
    placeholder,
  },
  ref,
) {
  const [value, setValue] = useState("");
  const [inputMode, setInputMode] = useState<"text" | "voice">("text");
  /** 弹层模式：switch = 切换当前智能体（粘性）；mention = @ 指定本条回答者 */
  const [sheetMode, setSheetMode] = useState<"switch" | "mention" | null>(null);
  const [mention, setMention] = useState<MentionTarget | null>(null);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [selectedImage, setSelectedImage] = useState<PreparedChatImage | null>(
    null,
  );
  const [imageBusy, setImageBusy] = useState(false);

  const agents = useAgentStore((state) => state.agents);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const setSelectedAgent = useAgentStore((state) => state.setSelectedAgent);
  const ensureAgents = useAgentStore((state) => state.ensureAgents);

  useEffect(() => {
    void ensureAgents();
  }, [ensureAgents]);

  const currentAgent = findAgent(agents, selectedAgentId);
  const currentName = resolveAgentName(agents, selectedAgentId);
  const mentionCandidates = mentionAgents ?? agents;
  const canOpenSwitch = mode === "flex" && agents.length > 0;
  const canMention = mode !== "single" && mentionCandidates.length > 0;
  const effectiveModelAgentId = mention?.agentId ?? modelAgentId;
  const modelSelection = useAgentModelSelection(effectiveModelAgentId);
  const showModelSettings = Boolean(
    modelSelection.selectedModel &&
    ((modelSelection.options?.models.length ?? 0) > 1 ||
      isReasoningConfigurable(
        modelSelection.selectedModel.reasoningCapability,
      )),
  );
  const currentModelFingerprint = modelSelectionFingerprint(
    modelSelection.selection,
  );
  const modelChangedFromPreviousRound = Boolean(
    lastModelSelectionFingerprint &&
    currentModelFingerprint &&
    lastModelSelectionFingerprint !== currentModelFingerprint,
  );

  const renderIcon = (name: AppIconName, extraClassName = "") => (
    <AppIcon
      name={name}
      className={`h-[1.25rem] w-[1.25rem] ${extraClassName}`.trim()}
    />
  );

  const hasContent = value.trim().length > 0 || Boolean(selectedImage);
  const imageUnsupported = Boolean(
    selectedImage &&
    modelSelection.selectedModel &&
    !modelSelection.selectedModel.supportsVision,
  );

  const handleInput = (next: string) => {
    // 末尾新敲出 @ → 呼出提及选择（仅追加输入时触发，避免删除/粘贴误弹）
    if (
      canMention &&
      next.length > value.length &&
      next.endsWith("@") &&
      inputMode === "text"
    ) {
      setSheetMode("mention");
    }
    // 已有提及但 @名字 文本被删掉 → 提及随之取消
    if (mention && !next.includes(`@${mention.name}`)) {
      setMention(null);
    }
    setValue(next);
  };

  /** 设置一次性提及：补全/追加 @名字 文本并记录目标（成员条快捷 @ 也走这里） */
  const applyMention = (agent: AgentSummary) => {
    setInputMode("text");
    setValue((prev) =>
      prev.endsWith("@") ? `${prev}${agent.name} ` : `${prev}@${agent.name} `,
    );
    setMention({ agentId: agent.id, name: agent.name });
  };

  useImperativeHandle(ref, () => ({
    insertMention: applyMention,
    setDraft: (text: string) => {
      setInputMode("text");
      setMention(null);
      setValue(text);
    },
  }));

  const handleSheetSelect = (agent: AgentSummary) => {
    if (sheetMode === "switch") {
      setSelectedAgent(agent.isDefault ? null : agent.id);
    } else if (sheetMode === "mention") {
      applyMention(agent);
    }
    setSheetMode(null);
  };

  const clearMention = () => {
    if (!mention) return;
    // 同步移除输入框里的 @名字 文本（仅首个匹配）
    setValue((prev) =>
      prev.includes(`@${mention.name} `)
        ? prev.replace(`@${mention.name} `, "")
        : prev.replace(`@${mention.name}`, ""),
    );
    setMention(null);
  };

  const handleSend = async () => {
    const content = value.trim();
    if (
      (!content && !selectedImage) ||
      disabled ||
      isStreaming ||
      imageBusy ||
      imageUnsupported ||
      modelSelection.error
    )
      return;
    // single：回答者由后端按会话绑定解析；group：仅 @ 生效（不 @ = 自动路由）；
    // flex：本条 @ 优先于粘性选择。
    const effectiveAgentId = resolveOutgoingAgentId(
      mode,
      mention?.agentId,
      selectedAgentId,
    );
    try {
      setImageBusy(Boolean(selectedImage));
      const uploadedImage = selectedImage
        ? await uploadChatImage(selectedImage)
        : undefined;
      onSend(
        content,
        effectiveAgentId,
        modelSelection.selection,
        uploadedImage,
      );
      setValue("");
      setMention(null);
      setSelectedImage(null);
    } catch (error) {
      await Taro.showToast({
        title: error instanceof Error ? error.message : "图片上传失败",
        icon: "none",
      });
    } finally {
      setImageBusy(false);
    }
  };

  const handleChooseImage = async () => {
    if (disabled || imageBusy) return;
    try {
      const action = await Taro.showActionSheet({
        itemList: ["拍照", "从相册选择"],
      });
      const selected = await Taro.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: [action.tapIndex === 0 ? "camera" : "album"],
        sizeType: ["original"],
      });
      const file = selected.tempFiles[0];
      if (!file?.tempFilePath) return;
      setImageBusy(true);
      await Taro.showLoading({ title: "处理图片中", mask: true });
      setInputMode("text");
      setSelectedImage(await prepareChatImage(file.tempFilePath));
    } catch (error) {
      const message = readTaroErrorMessage(error);
      if (!message.toLowerCase().includes("cancel")) {
        await Taro.showToast({
          title: message || "图片处理失败",
          icon: "none",
        });
      }
    } finally {
      Taro.hideLoading();
      setImageBusy(false);
    }
  };

  const handleStop = () => {
    onStop?.();
  };

  const toggleMode = () => {
    setInputMode((prev) => (prev === "text" ? "voice" : "text"));
  };

  const handleRecordComplete = (filePath: string) => {
    if (disabled || isStreaming || modelSelection.error) return;
    const effectiveAgentId = resolveOutgoingAgentId(
      mode,
      mention?.agentId,
      selectedAgentId,
    );
    onRecordComplete?.(filePath, effectiveAgentId, modelSelection.selection);
    setMention(null);
  };

  const renderRightButtons = () => {
    if (inputMode === "voice") {
      return (
        <>
          <IconButton
            icon={renderIcon("edit")}
            variant="ghost"
            shape="round"
            onClick={toggleMode}
          />
          <IconButton
            icon={renderIcon("plus")}
            variant="ghost"
            shape="round"
            onClick={handleChooseImage}
          />
        </>
      );
    }

    if (isStreaming) {
      return (
        <>
          <IconButton
            icon={renderIcon("plus")}
            variant="ghost"
            shape="round"
            onClick={handleChooseImage}
          />
          <IconButton
            icon={renderIcon("stop", "text-[var(--lb-on-accent)]")}
            variant="primary"
            shape="round"
            onClick={handleStop}
          />
        </>
      );
    }

    if (hasContent) {
      return (
        <>
          <IconButton
            icon={renderIcon("plus")}
            variant="ghost"
            shape="round"
            onClick={handleChooseImage}
          />
          <IconButton
            icon={renderIcon("send", "text-[var(--lb-on-accent)]")}
            variant="primary"
            shape="round"
            onClick={handleSend}
          />
        </>
      );
    }

    return (
      <>
        <IconButton
          icon={renderIcon("mic")}
          variant="ghost"
          shape="round"
          onClick={toggleMode}
        />
        <IconButton
          icon={renderIcon("plus")}
          variant="ghost"
          shape="round"
          onClick={handleChooseImage}
        />
      </>
    );
  };

  return (
    <View
      className="px-[0.75rem] pt-[0.625rem] box-border"
      style={{ paddingBottom: reserveSafeArea ? safeAreaBottom(12) : 12 }}
    >
      {modelSelection.error && effectiveModelAgentId ? (
        <Text className="mb-[0.375rem] block text-[0.6875rem] text-[var(--lb-danger)]">
          模型设置加载失败，本条消息暂不可发送
        </Text>
      ) : null}
      {modelChangedFromPreviousRound ? (
        <Text className="mb-[0.375rem] block text-[0.6875rem] text-[var(--lb-warning)]">
          模型设置与上一轮不同，建议新建会话以保持上下文一致
        </Text>
      ) : null}
      {imageUnsupported ? (
        <Text className="mb-[0.375rem] block text-[0.6875rem] text-[var(--lb-danger)]">
          当前模型不支持图片输入
        </Text>
      ) : null}

      {selectedImage ? (
        <View className="mb-[0.5rem] flex items-end gap-[0.5rem]">
          <View className="relative h-[4.5rem] w-[4.5rem] overflow-hidden rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)]">
            <Image
              className="h-full w-full"
              src={selectedImage.previewUrl}
              mode="aspectFill"
            />
            <View
              className="absolute right-[0.25rem] top-[0.25rem] flex h-[1.5rem] w-[1.5rem] items-center justify-center rounded-full bg-[rgba(0,0,0,0.62)] text-white"
              onClick={() => !imageBusy && setSelectedImage(null)}
            >
              <AppIcon name="close" className="h-[0.875rem] w-[0.875rem]" />
            </View>
          </View>
          {imageBusy ? (
            <Text className="pb-[0.125rem] text-[0.6875rem] text-[var(--lb-text-muted)]">
              正在处理图片…
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* 工具条：Agent 身份和模型设置都属于下一条消息，在输入框上方集中展示。 */}
      {(mode !== "single" && (mode === "flex" || mention)) ||
      showModelSettings ? (
        <View className="mb-[0.5rem] flex min-w-0 items-center gap-[0.5rem]">
          {mode === "flex" ? (
            <View
              className="flex min-w-0 max-w-[60%] items-center gap-[0.375rem] rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] py-[0.25rem] pl-[0.25rem] pr-[0.625rem] box-border"
              onClick={() => canOpenSwitch && setSheetMode("switch")}
            >
              <AgentAvatar
                className="h-[1.375rem] w-[1.375rem] shrink-0 rounded-full bg-[var(--lb-surface)]"
                name={currentName}
                avatar={currentAgent?.avatar}
                size="xs"
              />
              <Text className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-medium leading-[1.3] text-[var(--lb-text-primary)]">
                {currentName}
              </Text>
              {canOpenSwitch ? (
                <AppIcon
                  name="chevronDown"
                  className="h-[0.75rem] w-[0.75rem] shrink-0 text-[var(--lb-text-muted)]"
                />
              ) : null}
            </View>
          ) : null}

          {mention ? (
            <View
              className="flex min-w-0 items-center gap-[0.25rem] rounded-full bg-[var(--lb-accent-soft)] px-[0.625rem] py-[0.3125rem] box-border"
              onClick={clearMention}
            >
              <Text className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] font-medium leading-[1.3] text-[var(--lb-accent-ink)]">
                本条 @{mention.name}
              </Text>
              <AppIcon
                name="close"
                className="h-[0.625rem] w-[0.625rem] shrink-0 text-[var(--lb-accent-ink)]"
              />
            </View>
          ) : null}

          {showModelSettings && modelSelection.selectedModel ? (
            <View
              className="flex min-w-0 items-center gap-[0.25rem] rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] px-[0.625rem] py-[0.3125rem]"
              onClick={() => setModelSheetOpen(true)}
            >
              <Text className="block max-w-[9rem] overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] font-medium text-[var(--lb-text-secondary)]">
                {modelSelection.selectedModel.name}
              </Text>
              <AppIcon
                name="chevronDown"
                className="h-[0.625rem] w-[0.625rem] shrink-0 text-[var(--lb-text-muted)]"
              />
            </View>
          ) : null}
        </View>
      ) : null}

      <View className="flex items-end gap-[0.375rem] rounded-[calc(var(--lb-radius-md)_+_0.75rem)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface-strong)] py-[0.3125rem] pl-[0.875rem] pr-[0.3125rem] shadow-[var(--lb-shadow-glow)] box-border">
        <View className="flex-1 min-w-0">
          {inputMode === "text" ? (
            <Textarea
              className="w-full min-h-[2.25rem] max-h-[7.5rem] bg-transparent px-[0.125rem] py-[0.375rem] box-border text-[0.9375rem] leading-[1.5] text-[var(--lb-text-primary)]"
              value={value}
              onInput={(e) => handleInput(e.detail.value)}
              placeholder={
                placeholder ??
                (mode === "single"
                  ? "发消息..."
                  : "发消息，输入 @ 指定谁来回答...")
              }
              placeholderClass="text-[var(--lb-text-muted)]"
              maxlength={2000}
              // 流式输出期间只挡「发送」不挡「输入」：右侧按钮此时是停止键，
              // 本就没有发送入口，再禁用输入框只会让人连下一句都打不了。
              disabled={disabled || Boolean(modelSelection.error)}
              autoHeight
              confirmType="send"
              onConfirm={handleSend}
            />
          ) : (
            <VoiceButton
              onRecordComplete={handleRecordComplete}
              disabled={
                disabled || isStreaming || Boolean(modelSelection.error)
              }
            />
          )}
        </View>

        <View className="flex items-center gap-[0.375rem]">
          {renderRightButtons()}
        </View>
      </View>

      {sheetMode ? (
        <AgentSheet
          title={sheetMode === "mention" ? "@ 谁来回答这条" : "切换智能体"}
          agents={sheetMode === "mention" ? mentionCandidates : agents}
          selectedAgentId={sheetMode === "switch" ? selectedAgentId : undefined}
          onSelect={handleSheetSelect}
          onClose={() => setSheetMode(null)}
        />
      ) : null}

      {modelSheetOpen &&
      modelSelection.options &&
      modelSelection.selectedModel ? (
        <ModelSelectionSheet
          models={modelSelection.options.models}
          selectedModel={modelSelection.selectedModel}
          reasoning={modelSelection.selection?.reasoning}
          onSelectModel={modelSelection.changeModel}
          onChangeReasoning={modelSelection.changeReasoning}
          onClose={() => setModelSheetOpen(false)}
        />
      ) : null}
    </View>
  );
});

function readTaroErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "errMsg" in error &&
    typeof error.errMsg === "string"
  ) {
    return error.errMsg;
  }
  return "图片处理失败";
}
