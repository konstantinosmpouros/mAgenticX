// Lightweight AG-UI protocol helpers for event typing in the UI

export enum AGUIEventType {
  RUN_STARTED = 'RUN_STARTED',
  RUN_FINISHED = 'RUN_FINISHED',
  RUN_ERROR = 'RUN_ERROR',

  THINKING_START = 'THINKING_START',
  THINKING_END = 'THINKING_END',
  THINKING_TEXT_MESSAGE_START = 'THINKING_TEXT_MESSAGE_START',
  THINKING_TEXT_MESSAGE_CONTENT = 'THINKING_TEXT_MESSAGE_CONTENT',
  THINKING_TEXT_MESSAGE_END = 'THINKING_TEXT_MESSAGE_END',

  TEXT_MESSAGE_START = 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CHUNK = 'TEXT_MESSAGE_CHUNK',
  TEXT_MESSAGE_CONTENT = 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END = 'TEXT_MESSAGE_END',

  TOOL_CALL_START = 'TOOL_CALL_START',
  TOOL_CALL_ARGS = 'TOOL_CALL_ARGS',
  TOOL_CALL_RESULT = 'TOOL_CALL_RESULT',
  TOOL_CALL_END = 'TOOL_CALL_END',
}

export type AGUIEvent = { type: string; [k: string]: any };

export function asEventType(e: AGUIEvent): AGUIEventType | null {
  const t = String(e?.type ?? '').toUpperCase();
  return (AGUIEventType as any)[t] ?? null;
}

export function isEvent(e: AGUIEvent, t: AGUIEventType): boolean {
  return String(e?.type ?? '').toUpperCase() === t;
}

