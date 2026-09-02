import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ImageIcon, Upload } from "lucide-react";
import { AgentAvatar } from "@/components/agent-identity";
import { AvatarPickerDialog } from "@/components/avatar-picker-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAgentFlows,
  useAgentMutations,
  useModelPresets,
} from "@/hooks/queries";
import { uploadAgentAvatar } from "@/api/upload";
import { ApiError } from "@/api/client";
import type { Agent, AgentInput } from "@/api/types";
import { capabilityMeta } from "@/lib/model-preset-meta";

/**
 * 智能体编辑弹窗
 * @param props 待编辑的智能体（null = 新建）、开关与关闭回调
 * @returns 返回居中模态弹窗
 * @description 从侧边抽屉改为居中弹窗：字段收敛到「身份 + 执行」两组之后表单已经很短，
 * 抽屉那种窄长布局反而让描述文字挤成多行。
 *
 * 分组不是纯装饰：**身份**是这个智能体是谁（名称/头像/人设），**执行**是它怎么干活
 * （模型、绑哪张 Flow）。工具与编排都已移到 Flow 节点上配置，这里不再出现。
 */
export function AgentFormDialog({
  agent,
  open,
  onClose,
}: {
  agent: Agent | null; // null = 新建
  open: boolean;
  onClose: () => void;
}) {
  const { create, update } = useAgentMutations();
  const { data: modelPresets } = useModelPresets();
  const { data: agentFlows } = useAgentFlows();
  const [form, setForm] = useState<AgentInput>({ name: "" });
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setPickerOpen(false);
    if (agent) {
      setForm({
        name: agent.name,
        description: agent.description,
        avatar: agent.avatar ?? "",
        systemPrompt: agent.systemPrompt ?? "",
        modelPreset: agent.modelPreset ?? "",
        defaultFlowVersionId: agent.defaultFlowVersionId,
        enabled: agent.enabled,
        visible: agent.visible,
        minimumMembershipTier: agent.minimumMembershipTier,
      });
    } else {
      setForm({
        name: "",
        enabled: true,
        visible: true,
        minimumMembershipTier: "FREE",
      });
    }
  }, [agent, open]);

  const submitting = create.isPending || update.isPending;
  // 后端 ensurePublishedFlowVersion 只接受 PUBLISHED；列出草稿只会换来一个 400
  const publishedFlowVersions = (agentFlows ?? []).flatMap((flow) =>
    flow.publishedVersion
      ? [
          {
            versionId: flow.publishedVersion.id,
            label: `${flow.name} · v${flow.publishedVersion.version}`,
          },
        ]
      : [],
  );

  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await uploadAgentAvatar(file);
      setForm((prev) => ({ ...prev, avatar: url }));
      toast.success("头像已上传");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "上传失败，请重试");
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error("请填写名称");
      return;
    }
    const payload: AgentInput = {
      ...form,
      avatar: form.avatar?.trim() || null,
      systemPrompt: form.systemPrompt?.trim() || null,
      modelPreset: form.modelPreset?.trim() || null,
    };
    try {
      if (agent) {
        await update.mutateAsync({ id: agent.id, body: payload });
        toast.success("已更新");
      } else {
        await create.mutateAsync(payload);
        toast.success("已创建");
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "保存失败，请重试");
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent>
          <div className="space-y-1">
            <DialogTitle>{agent ? "编辑智能体" : "新建智能体"}</DialogTitle>
            <DialogDescription>
              工具与编排在绑定的 Flow 里配置，这里只定身份与执行入口
            </DialogDescription>
          </div>

          {/* 弹窗本身 overflow-hidden 且限高，滚动交给这一层 */}
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            <Section title="身份">
              <div className="flex items-start gap-4">
                <AgentAvatar
                  name={form.name}
                  avatar={form.avatar}
                  className="h-16 w-16 shrink-0 rounded-lg"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) =>
                        void handleAvatarFile(e.target.files?.[0])
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={uploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="mr-1.5 h-3.5 w-3.5" />
                      {uploading ? "上传中…" : "上传"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPickerOpen(true)}
                    >
                      <ImageIcon className="mr-1.5 h-3.5 w-3.5" />
                      已上传
                    </Button>
                  </div>
                  <Input
                    value={form.avatar ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, avatar: e.target.value })
                    }
                    placeholder="也可直接填图片 URL，留空显示名称首字"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="名称">
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="通用助手"
                  />
                </Field>
                <Field label="描述">
                  <Input
                    value={form.description ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, description: e.target.value })
                    }
                    placeholder="一句话说明它擅长什么"
                  />
                </Field>
              </div>

              <Field label="系统提示词" hint="留空用内置默认人设">
                <Textarea
                  value={form.systemPrompt ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, systemPrompt: e.target.value })
                  }
                  rows={4}
                />
              </Field>
            </Section>

            <Section title="执行">
              <Field
                label="默认模型"
                hint="供 Flow 节点选「跟随智能体默认」时解析；节点也可各自指定"
              >
                <Select
                  value={form.modelPreset ?? ""}
                  onValueChange={(v) =>
                    setForm({ ...form, modelPreset: v || null })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="用全局默认模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {(modelPresets ?? []).map((m) => (
                      <SelectItem key={m.id} value={m.presetId}>
                        {m.name}（{m.presetId}）·{" "}
                        {capabilityMeta(m.capability).name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field
                label="绑定 Flow 版本"
                hint="只能绑已发布版本。所有聊天都按 Flow 执行——绑定后走这张图，留空则走内置的「直接回复」Flow"
              >
                <Select
                  value={form.defaultFlowVersionId ?? ""}
                  onValueChange={(v) =>
                    setForm({ ...form, defaultFlowVersionId: v || null })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="不绑定，执行内置的直接回复 Flow" />
                  </SelectTrigger>
                  <SelectContent>
                    {publishedFlowVersions.map((option) => (
                      <SelectItem
                        key={option.versionId}
                        value={option.versionId}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {publishedFlowVersions.length === 0 ? (
                  <p className="text-xs text-[var(--lb-warning)]">
                    当前没有已发布的 Flow 版本，请先在 Flow 页发布一个。
                  </p>
                ) : null}
              </Field>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={form.enabled ?? true}
                  disabled={submitting || agent?.isDefault}
                  onChange={(e) =>
                    setForm({ ...form, enabled: e.target.checked })
                  }
                />
                启用
              </label>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={form.visible ?? true}
                  disabled={submitting || agent?.isDefault}
                  onChange={(e) =>
                    setForm({ ...form, visible: e.target.checked })
                  }
                />
                客户端展示
              </label>

              <Field
                label="最低会员等级"
                hint={
                  agent?.isDefault
                    ? "默认智能体固定为 FREE 且始终展示"
                    : "会员不足的智能体仍会展示，但聊天入口会锁定"
                }
              >
                <Select
                  value={form.minimumMembershipTier ?? "FREE"}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      minimumMembershipTier:
                        value as AgentInput["minimumMembershipTier"],
                    })
                  }
                  disabled={submitting || agent?.isDefault}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FREE">FREE · 所有人</SelectItem>
                    <SelectItem value="PLUS">PLUS · Plus 会员</SelectItem>
                    <SelectItem value="PRO">PRO · Pro 会员</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </Section>
          </div>

          <div className="flex shrink-0 justify-end gap-2 border-t border-border pt-4">
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "保存中…" : "保存"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AvatarPickerDialog
        open={pickerOpen}
        currentUrl={form.avatar}
        onSelect={(url) => setForm((prev) => ({ ...prev, avatar: url }))}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

/**
 * 表单分区
 * @param props 分区标题与内容
 * @returns 返回带标题的一组字段
 */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * 单个字段
 * @param props 标签、可选说明与控件
 * @returns 返回标签 + 控件 + 说明
 * @description 说明单独一行而不是塞进 label 括号里：原先「头像（可上传 ≤2MB 图片，
 * 或复用已上传，留空显示名称首字）」这种标签在窄容器里会折成三行，把控件挤下去。
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
