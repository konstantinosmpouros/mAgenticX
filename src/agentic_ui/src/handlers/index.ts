// Transitional aggregator for the workspace shell's handler wiring.
// The handler modules now live in their feature folders (features/<feature>/
// handlers/*). This barrel keeps the shell's single `@/handlers` import working
// until the shell is thinned into app/ and switched to per-feature imports.
export * from '@/features/attachments/handlers/attachments';
export * from '@/features/chat/handlers/conversations';
export * from '@/features/catalog/handlers/agents';
export * from '@/features/auth/handlers/auth';
export * from '@/features/chat/handlers/messages';
export * from '@/features/settings/handlers/preferences';
export * from '@/features/chat/handlers/shortcuts';
export * from '@/features/sharing/handlers/share';
export * from '@/features/reporting/handlers/report';
export * from '@/features/voice/handlers/voice';
export * from '@/features/search/handlers/search';
export * from '@/features/chat/handlers/ui';
