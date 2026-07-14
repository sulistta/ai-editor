import type { AgentQuestion, ChatMessage } from "../types";

export function formatAgentQuestion(question: AgentQuestion): string {
  const sections = [question.context, question.text].filter((value): value is string => Boolean(value));
  if (question.options.length) {
    sections.push(question.options.map((option, index) => `${index + 1}. ${option}`).join("\n"));
  }
  return sections.join("\n\n");
}

const retryRequests = /^(tente|tenta|tentar)(\s+(de\s+novo|novamente|outra\s+vez))?[.!?\s]*$|^(retry|again)[.!?\s]*$/i;

export function resolveRetryPrompt(prompt: string, history: ChatMessage[]): string {
  const trimmed = prompt.trim();
  if (!retryRequests.test(trimmed)) return trimmed;
  return [...history].reverse().find((message) => message.role === "user" && !retryRequests.test(message.text.trim()))?.text.trim() || trimmed;
}
