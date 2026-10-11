// ------------------------------------------------------
// Slash commands (plan 35)
// ------------------------------------------------------

// `SlashCommand` is inferred from its Zod contract in `../schemas`.
export type { SlashCommand } from "../schemas";

/** The command a user message runs — only its name: the argument is the
 *  message's content, and the instruction lives in the agents service. */
export type CommandRef = { name: string };
