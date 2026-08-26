import { ShieldCheck } from "lucide-react";

import { LegalPage, type LegalSection } from "@/shared/ui/legal-page";

const sections: LegalSection[] = [
  {
    title: "Information We Collect",
    body: "We collect information you provide directly, such as your username and account credentials. We also collect conversation data, messages, and file attachments you submit through the platform, as well as usage data including session activity, feature interactions, and error logs. This data is necessary to provide, maintain, and improve the service.",
  },
  {
    title: "How We Use Your Information",
    body: "We use the information we collect to provide, maintain, and improve the platform; to authenticate your identity and manage your session; to process and respond to your messages and agent requests; to generate conversation titles and summaries; and to diagnose technical issues and monitor service health. We do not sell your personal data to third parties.",
  },
  {
    title: "Data Storage",
    body: "Conversation data, messages, and file attachments are stored in our PostgreSQL database. Vector embeddings used for retrieval are stored in a ChromaDB vector store. Authentication tokens are managed via HashiCorp Vault. All data is stored on secured infrastructure and is not shared with third parties except as described in this policy.",
  },
  {
    title: "AI Processing",
    body: "Your messages and attached files are sent to AI model providers (such as OpenAI) to generate responses. These providers process your data under their own terms of service and privacy policies. Please do not include sensitive personal information such as passwords, financial data, or government-issued ID numbers in your conversations.",
  },
  {
    title: "Data Retention",
    body: "Your conversations and attachments are retained as long as your account is active. You may delete individual conversations at any time through the platform interface. Archived conversations are retained until permanently deleted by you or by an administrator. Upon account deletion, your data is removed in accordance with our data deletion procedures.",
  },
  {
    title: "Cookies and Session Data",
    body: "We use session cookies to maintain your authenticated state across requests. These cookies are HTTP-only, secure, and scoped to this platform only. We do not use tracking cookies, third-party advertising cookies, or any form of cross-site tracking. Cookie preferences may be managed through your browser settings.",
  },
  {
    title: "Data Security",
    body: "We implement industry-standard security measures including encrypted connections (TLS), mutual TLS between internal services, token-based authentication via HashiCorp Vault, and CSRF protection on all state-mutating endpoints. Access to production data is restricted to authorized personnel. No method of transmission over the internet is 100% secure, and we cannot guarantee absolute security.",
  },
  {
    title: "Your Rights",
    body: "You have the right to access, correct, or delete your personal data at any time. You may request a copy of your data, ask us to correct inaccuracies, or request account deletion by contacting us through the Support section in your profile settings. We will respond to verified requests within a reasonable timeframe.",
  },
  {
    title: "Third-Party Services",
    body: "mAgenticX integrates with third-party services including OpenAI for AI inference, Microsoft Office Online for previewing Office documents (Word, Excel, and PowerPoint attachments are transmitted to Microsoft's viewer service to render an in-app preview), and optionally MCP-compatible tools (such as Tavily for web search). These services operate under their own privacy policies and terms of service. We encourage you to review those policies before using features that depend on these integrations.",
  },
  {
    title: "Changes to This Policy",
    body: "We may update this Privacy Policy from time to time to reflect changes in our practices, technology, or applicable law. We will notify you of significant changes by updating the date at the top of this page. For material changes, we will provide more prominent notice where feasible. Continued use of the platform after changes are posted constitutes acceptance of the revised policy.",
  },
];

export default function PrivacyPolicy() {
  return (
    <LegalPage
      icon={<ShieldCheck size={18} />}
      title="Privacy Policy"
      heading="Your Privacy"
      intro={
        "This Privacy Policy describes how mAgenticX collects, uses, and protects your personal information. We are committed to handling your data responsibly and transparently."
      }
      lastUpdated="June 2026"
      version="v1.1"
      idPrefix="pp"
      sections={sections}
      footer={
        <>
          Privacy questions or data requests? Contact us through the{" "}
          <span className="font-semibold text-foreground">Support</span> section in the Help tab of
          your profile settings.
        </>
      }
    />
  );
}
