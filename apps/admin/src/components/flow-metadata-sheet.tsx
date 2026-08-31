import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AgentFlow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAgentFlowMutations } from "@/hooks/queries";
import { describeApiError } from "@/lib/flow-meta";

interface FlowMetadataSheetProps {
  flow: AgentFlow | null;
  open: boolean;
  onClose: () => void;
}

/**
 * Flow 基本信息编辑侧栏
 * @param props 当前 Flow、打开状态与关闭回调
 * @returns 返回名称和描述编辑表单
 * @description 表单只维护控制面元数据；保存后后端会在同一事务中同步最高版本号草稿的
 * Definition 顶层字段。发布与归档版本保持不可变，因此这里不编辑任何历史工件。
 */
export function FlowMetadataSheet({
  flow,
  open,
  onClose,
}: FlowMetadataSheetProps) {
  const { updateMetadata } = useAgentFlowMutations(flow?.id);
  const [form, setForm] = useState({ name: "", description: "" });
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  const key = open && flow ? `${flow.id}:${flow.updatedAt}` : null;
  if (key !== syncedKey) {
    setSyncedKey(key);
    if (flow && open) {
      setForm({ name: flow.name, description: flow.description });
    }
  }

  const name = form.name.trim();
  const description = form.description.trim();
  const valid = name.length >= 1 && name.length <= 100 && description.length <= 2000;

  /**
   * 提交 Flow 基本信息
   * @returns 无返回值
   * @description 在前端先执行与 DTO 一致的长度检查，服务端仍保留最终校验；失败时保留表单内容。
   */
  const handleSubmit = async () => {
    if (!flow || !valid) {
      toast.error("名称需为 1–100 字，描述最多 2000 字");
      return;
    }
    try {
      await updateMetadata.mutateAsync({
        flowId: flow.id,
        body: { name, description },
      });
      toast.success("Flow 基本信息已更新");
      onClose();
    } catch (error) {
      toast.error(describeApiError(error, "更新失败"));
    }
  };

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>编辑 Flow 基本信息</SheetTitle>
          <SheetDescription>
            名称与描述会同步到最新草稿；已发布和已归档版本不变。
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="flow-name">名称</Label>
            <Input
              id="flow-name"
              value={form.name}
              maxLength={100}
              onChange={(event) =>
                setForm((current) => ({ ...current, name: event.target.value }))
              }
            />
            <p className="text-right text-xs text-muted-foreground">
              {form.name.length}/100
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="flow-description">描述</Label>
            <Textarea
              id="flow-description"
              value={form.description}
              maxLength={2000}
              className="min-h-[180px]"
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
            <p className="text-right text-xs text-muted-foreground">
              {form.description.length}/2000
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!valid || updateMetadata.isPending}
            >
              {updateMetadata.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              保存
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
