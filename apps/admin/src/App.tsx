import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RequireAdmin } from "@/components/require-admin";
import { AppShell } from "@/components/app-shell";
import { LoginPage } from "@/pages/login";
import { DashboardPage } from "@/pages/dashboard";
import { AgentsPage } from "@/pages/agents";
import { AgentManagePage } from "@/pages/agent-manage";
import { ToolsPage } from "@/pages/tools";
import { TasksPage } from "@/pages/tasks";
import { ErrorsPage } from "@/pages/errors";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
