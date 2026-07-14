import { describe, expect, it } from "vitest";
import { formatAgentQuestion, resolveRetryPrompt } from "./agent";

describe("agent questions", () => {
  it("formats context, question and answer options for the chat history", () => {
    expect(formatAgentQuestion({
      context: "Isso define a duração dos cortes.",
      text: "Qual ritmo você prefere?",
      options: ["Dinâmico", "Contemplativo"],
    })).toBe("Isso define a duração dos cortes.\n\nQual ritmo você prefere?\n\n1. Dinâmico\n2. Contemplativo");
  });

  it("keeps free-form questions concise", () => {
    expect(formatAgentQuestion({ text: "Qual deve ser o foco?", options: [] })).toBe("Qual deve ser o foco?");
  });
});

describe("agent retry context", () => {
  it("reuses the last substantive user request for a retry message", () => {
    const history = [
      { id: "1", role: "user" as const, text: "Transforme o projeto em 9:16", createdAt: 1 },
      { id: "2", role: "assistant" as const, text: "Serviço temporariamente indisponível", createdAt: 2 },
    ];
    expect(resolveRetryPrompt("tente novamente", history)).toBe("Transforme o projeto em 9:16");
    expect(resolveRetryPrompt("adicione legendas", history)).toBe("adicione legendas");
  });
});
