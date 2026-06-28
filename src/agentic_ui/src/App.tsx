import { useState } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { ChatShell } from "./pages/ChatPage";
import ChatView from "./pages/ChatView";
import TasksView from "./pages/TasksView";
import NotFound from "./pages/NotFound";
import Architecture from "./pages/Architecture";
import Login from "./pages/Login";
import SharedConversationPage from "./pages/SharedConvPage";
import Test from "./pages/Test";
import TermsAndConditions from "./pages/TermsAndConditions";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import { CookieConsentBanner } from "./components/ui/cookie-consent-banner";
import { hasCookieConsent } from "./lib/cookieConsentStorage";

const queryClient = new QueryClient();

const App = () => {
  const [consented, setConsented] = useState(() => hasCookieConsent());

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem={true}
        disableTransitionOnChange={true}
        storageKey="theme"
      >
        <TooltipProvider>
          <Toaster />
          <Sonner />
          {consented ? (
            <Routes>
              {/* Layout route: ChatShell is the persistent shell (sidebar,
                  providers, modals) and never unmounts across these children.
                  The URL is the single source of truth for which view renders
                  in the shell's <Outlet/>. */}
              <Route element={<ChatShell />}>
                <Route path="/" element={<ChatView />} />
                <Route path="/c/:conversationId" element={<ChatView />} />
                <Route path="/tasks" element={<TasksView />} />
              </Route>
              <Route path="/login" element={<Login />} />
              <Route path="/share/:token" element={<SharedConversationPage />} />
              <Route path="/architecture" element={<Architecture />} />
              <Route path="/terms" element={<TermsAndConditions />} />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              <Route path="/test" element={<Test />} />
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
                      <div className="pointer-events-none select-none">
                        <Login />
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
