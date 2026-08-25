// ------------------------------------------------------
// Other Schemas from UI
// ------------------------------------------------------
// Thinking state type used in the application
export type ThinkingState = {
  messageId: string;
  thoughts: string[];
  currentThoughtIndex: number;
  isActive: boolean;
  isDone: boolean;
  startTime: number;
  endTime?: number;
  branchPath?: string[];
};
