/**
 * Slash commands (plan 35): the composer's "/" menu for one agent.
 *
 * Every command is listed, each runnable or with the reason it is not. A
 * message runs a command by naming it (`MessageIn.command`); the instruction
 * the model receives lives in the agents service and never passes through here.
 */
import type { SlashCommand } from "../types";
import { requestJson } from "../http";
import { SlashCommandListSchema } from "../schemas";
import { COMMANDS_BASE_PATH } from "./paths";

export async function getAgentCommands(userId: string, agentId: string): Promise<SlashCommand[]> {
  return requestJson(`${COMMANDS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(agentId)}`, {
    schema: SlashCommandListSchema,
    fallbackMessage: "Could not load the commands",
  });
}
