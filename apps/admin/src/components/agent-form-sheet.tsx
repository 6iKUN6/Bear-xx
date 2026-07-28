import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentMutations } from "@/hooks/queries";
import { ApiError } from "@/api/client";
import type { Agent, AgentInput, AgentStrategy } from "@/api/types";

const STRATEGIES: AgentStrategy[] = [
  "AUTO",
  "DIRECT",
  "REACT",
  "PLAN_EXECUTE",
  "HYBRID",
];

/** 逗号/空格分隔字符串 ↔ 数组 */
const toList = (s: string) =>
  s
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function AgentFormSheet({
  agent,
  open,
  onClose,
}: {
  agent: Agent | null; // null = 新建
  open: boolean;
  onClose: () => void;
}) {
  const { create, update } = useAgentMutations();
  const [form, setForm] = useState<AgentInput>({ name: "" });
  const [toolGroupsText, setToolGroupsText] = useState("");
  const [skillsText, setSkillsText] = useState("");

  useEffect(() => {
    if (!open) return;
    if (agent) {
      setForm({
        name: agent.name,
        description: agent.description,
        systemPrompt: agent.systemPrompt ?? "",
        modelPreset: agent.modelPreset ?? "",
        defaultStrategy: agent.defaultStrategy,
        allowedStrategies: agent.allowedStrategies,
        maxSteps: agent.maxSteps,
        enabled: agent.enabled,
      });
      setToolGroupsText(agent.toolGroups.join(", "));
      setSkillsText(agent.skills.join(", "));
    } else {
      setForm({ name: "", defaultStrategy: "AUTO", enabled: true });
      setToolGroupsText("");
      setSkillsText("");
    }
  }, [agent, open]);

  const submitting = create.isPending || update.isPending;

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error("请填写名称");
      return;
    }
    const payload: AgentInput = {
      ...form,
      toolGroups: toList(toolGroupsText),
      skills: toList(skillsText),
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
      toast.error(
        err instanceof ApiError ? err.message : "保存失败，请重试",
      );
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{agent ? "编辑智能体" : "新建智能体"}</SheetTitle>
        </SheetHeader>

        <div className="space-y-4">
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
            />
          </Field>
          <Field label="系统提示词（留空用内置默认）">
            <Textarea
              value={form.systemPrompt ?? ""}
              onChange={(e) =>
                setForm({ ...form, systemPrompt: e.target.value })
              }
              rows={4}
            />
          </Field>
          <Field label="模型预设（留空用默认）">
            <Input
              value={form.modelPreset ?? ""}
              onChange={(e) =>
                setForm({ ...form, modelPreset: e.target.value })
              }
              placeholder="kimi"
            />
          </Field>
          <Field label="默认策略">
            <Select
              value={form.defaultStrategy ?? "AUTO"}
              onValueChange={(v) =>
                setForm({ ...form, defaultStrategy: v as AgentStrategy })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRATEGIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="工具组（逗号分隔，如 default）">
            <Input
              value={toolGroupsText}
              onChange={(e) => setToolGroupsText(e.target.value)}
              placeholder="default"
            />
          </Field>
          <Field label="技能（逗号分隔）">
            <Input
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
            />
          </Field>
          <Field label="最大步数（1-10，留空不限）">
            <Input
              type="number"
              min={1}
              max={10}
              value={form.maxSteps ?? ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  maxSteps: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={form.enabled ?? true}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            启用
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "保存中…" : "保存"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
