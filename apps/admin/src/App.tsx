import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ConfirmHost } from "@/components/confirm-dialog";
import { RequireAdmin, RequireSuperAdmin } from "@/components/require-admin";
import { AppShell } from "@/components/app-shell";
import { LoginPage } from "@/pages/login";
import { DashboardPage } from "@/pages/dashboard";
import { AgentsPage } from "@/pages/agents";
import { AgentManagePage } from "@/pages/agent-manage";
import { ToolsPage } from "@/pages/tools";
import { TasksPage } from "@/pages/tasks";
import { ErrorsPage } from "@/pages/errors";
import { AgentTestPage } from "@/pages/agent-test";
import { ModelsPage } from "@/pages/models";
import { FlowsPage } from "@/pages/flows";
import { FlowDetailPage } from "@/pages/flow-detail";
import { FlowEditorPage } from "@/pages/flow-editor";
import { UsersPage } from "@/pages/users";
import { ResourcesPage } from "@/pages/resources";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* 画布编辑器不套 AppShell：三栏加画布需要整屏宽度，导航栏在这里只是干扰。
            仍然经 RequireAdmin，鉴权不能因为换布局就漏掉。 */}
        <Route
          path="/flows/:flowId/versions/:versionId/edit"
          element={
            <RequireAdmin>
              <FlowEditorPage />
            </RequireAdmin>
          }
        />
        <Route
          element={
            <RequireAdmin>
              <AppShell />
            </RequireAdmin>
          }
        >
          <Route path="/" element={<DashboardPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/manage" element={<AgentManagePage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/errors" element={<ErrorsPage />} />
          <Route path="/debug" element={<AgentTestPage />} />
          <Route
            path="/models"
            element={
              <RequireSuperAdmin>
                <ModelsPage />
              </RequireSuperAdmin>
            }
          />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/resources" element={<ResourcesPage />} />
          <Route path="/flows" element={<FlowsPage />} />
          <Route path="/flows/:flowId" element={<FlowDetailPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ConfirmHost />
    </BrowserRouter>
  );
}
