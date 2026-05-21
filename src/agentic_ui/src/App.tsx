import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { ChatInterface } from "./pages/ChatPage";
import NotFound from "./pages/NotFound";
import Architecture from "./pages/Architecture";
import Login from "./pages/Login";
import SharedConversationPage from "./pages/SharedConvPage";
import Test from "./pages/Test";
import TermsAndConditions from "./pages/TermsAndConditions";
import PrivacyPolicy from "./pages/PrivacyPolicy";

const queryClient = new QueryClient();

const App = () => (
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
        <Routes>
          <Route path="/" element={<ChatInterface />} />
          <Route path="/login" element={<Login />} />
          <Route path="/share/:token" element={<SharedConversationPage />} />
          <Route path="/architecture" element={<Architecture />} />
          <Route path="/terms" element={<TermsAndConditions />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/test" element={<Test />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
