import { useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { PROJECT_STORAGE_KEY, useCreationStore } from "@/stores/creation-store";
import { downloadText, serializeProjects } from "@/lib/creation";
import { Sidebar } from "./Sidebar";
import { ChatView } from "./ChatView";
import { ProjectsPage } from "./ProjectsPage";
import { CreationWorkspace } from "./CreationWorkspace";
import { FlowsPage } from "./FlowsPage";
import { Button, Notice } from "./ui";

export function WorkbenchPage() {
  const [backupError, setBackupError] = useState("");
  const activeProjectId = useCreationStore((s) => s.activeProjectId);
  const page = useAppStore((s) => s.page);
  const error = useCreationStore((s) => s.error);
  const blocked = useCreationStore((s) => s.storageBlocked);
  return (
    <div className="workbench">
      <Sidebar />
      <div className="workbench-content">
        {error && (
          <Notice
            action={
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    try {
                      const store = useCreationStore.getState();
                      downloadText(
                        "sola-项目备份.json",
                        blocked
                          ? (localStorage.getItem(PROJECT_STORAGE_KEY) ?? "")
                          : serializeProjects(store.projects),
                        "application/json",
                      );
                    } catch {
                      setBackupError(
                        "无法读取本机存储，请保留当前窗口并检查设备的存储权限。",
                      );
                    }
                  }}
                >
                  导出备份
                </Button>
                <Button
                  onClick={() => {
                    if (blocked) useCreationStore.getState().hydrate();
                    else useCreationStore.getState().flush();
                  }}
                >
                  重试
                </Button>
              </div>
            }
          >
            {error}
          </Notice>
        )}
        {backupError && <Notice>{backupError}</Notice>}
        {page === "projects" ? (
          <ProjectsPage />
        ) : page === "creation" ? (
          <CreationWorkspace key={activeProjectId} />
        ) : page === "flows" ? (
          <FlowsPage />
        ) : (
          <ChatView />
        )}
      </div>
    </div>
  );
}
