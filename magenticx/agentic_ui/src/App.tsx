import { useState } from "react";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { THEME_ATTRIBUTE_VALUES, THEME_IDS, migrateStoredTheme } from "@/styles/theme/themes";
import { ThemeModeSync } from "@/shared/ui/theme-mode-sync";
import { WorkspaceShell } from "./app/WorkspaceShell";
import ChatView from "./pages/ChatView";
import AutomationsView from "./pages/AutomationsView";
import WorkflowView from "./pages/WorkflowView";
import WorkflowBuilderView from "./pages/WorkflowBuilderView";
import LegacyTasksRedirect from "./pages/LegacyTasksRedirect";
import AgentsView from "./pages/AgentsView";
import AgentsGallery from "./features/agents/pages/AgentsGallery";
import AgentPage from "./features/agents/pages/AgentPage";
import AgentBuilderPage from "./features/agents/pages/AgentBuilderPage";
import NotFound from "./pages/NotFound";
import Login from "./pages/Login";
import SharedConversationPage from "./pages/SharedConvPage";
import TermsAndConditions from "./pages/TermsAndConditions";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import { CookieConsentBanner } from "@/shared/ui/cookie-consent-banner";
import { hasCookieConsent } from "@/shared/lib/cookieConsentStorage";
import { AUTOMATIONS_PATH, LEGACY_TASKS_PATH } from "@/features/automations/lib/routes";
import { WORKFLOWS_PATH } from "@/features/workflows/lib/routes";

const queryClient = new QueryClient();

// The stored theme as an explicit choice (theme-init.js has normally done this
// before paint): a missing or "system" value becomes Daylight or Midnight from
// the device's preference, once. Also next-themes' default, for blocked storage.
const initialTheme = migrateStoredTheme();

const App = () => {
  const [consented, setConsented] = useState(() => hasCookieConsent());

  return (
    <QueryClientProvider client={queryClient}>
      {/* Themes are defined in src/styles/theme: `data-theme` picks one (the
          legacy "light"/"dark" map to Daylight and Midnight; there is no
          System option), and ThemeModeSync adds the `dark` class for the dark ones. */}
      <ThemeProvider
        attribute="data-theme"
        themes={THEME_IDS}
        value={THEME_ATTRIBUTE_VALUES}
        defaultTheme={initialTheme}
        enableSystem={false}
        enableColorScheme={false}
        disableTransitionOnChange={true}
        storageKey="theme"
      >
        <ThemeModeSync />
        <TooltipProvider>
          <Toaster />
          {consented ? (
            <Routes>
              {/* Layout route: WorkspaceShell is the persistent shell (sidebar,
                  providers, modals) and never unmounts across these children.
                  The URL is the single source of truth for which view renders
                  in the shell's <Outlet/>. */}
              <Route element={<WorkspaceShell />}>
                <Route path="/" element={<ChatView />} />
                <Route path="/c/:conversationId" element={<ChatView />} />
                <Route path={AUTOMATIONS_PATH} element={<AutomationsView />} />
                {/* The old Schedules URL, for one release: query kept. */}
                <Route path={LEGACY_TASKS_PATH} element={<LegacyTasksRedirect />} />
                {/* The workflow builder (plan 38, step 3): a new workflow, or one being edited. */}
                <Route path={`${WORKFLOWS_PATH}/new`} element={<WorkflowBuilderView />} />
                <Route path={`${WORKFLOWS_PATH}/:workflowId/edit`} element={<WorkflowBuilderView />} />
                {/* A workflow (its latest run), or one of its runs (plan 38). */}
                <Route path={`${WORKFLOWS_PATH}/:workflowId`} element={<WorkflowView />} />
                <Route
                  path={`${WORKFLOWS_PATH}/:workflowId/runs/:runId`}
                  element={<WorkflowView />}
                />
                {/* The Agents section: AgentsView is its own layout (the page
                    over the chat); the four pages render in its outlet. */}
                <Route path="/agents" element={<AgentsView />}>
                  <Route index element={<AgentsGallery />} />
                  <Route path="new" element={<AgentBuilderPage mode="create" />} />
                  <Route path=":agentId" element={<AgentPage />} />
                  <Route path=":agentId/edit" element={<AgentBuilderPage mode="edit" />} />
                </Route>
              </Route>
              <Route path="/login" element={<Login />} />
              <Route path="/share/:token" element={<SharedConversationPage />} />
              <Route path="/terms" element={<TermsAndConditions />} />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          ) : (
            <Routes>
              <Route path="/terms" element={<TermsAndConditions />} />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              <Route
                path="*"
                element={
                  <div className="flex h-screen flex-col overflow-hidden">
                    <div className="relative min-h-0 flex-1 overflow-hidden">
                      <div className="pointer-events-none select-none" aria-hidden="true">
                        <Login decorative />
                      </div>
                      <div className="absolute inset-0 bg-background/50 backdrop-blur-[3px]" />
                    </div>
                    <CookieConsentBanner onAccept={() => setConsented(true)} />
                  </div>
                }
              />
            </Routes>
          )}
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};

export default App;
