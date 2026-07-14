import type { ChatMessage } from "../types";

const retryRequests = /^(tente|tenta|tentar)(\s+(de\s+novo|novamente|outra\s+vez))?[.!?\s]*$|^(retry|again)[.!?\s]*$/i;

export function resolveRetryPrompt(prompt: string, history: ChatMessage[]): string {
  const trimmed = prompt.trim();
  if (!retryRequests.test(trimmed)) return trimmed;
  return [...history].reverse().find((message) => message.role === "user" && !retryRequests.test(message.text.trim()))?.text.trim() || trimmed;
}
