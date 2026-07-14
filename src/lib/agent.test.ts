import { describe, expect, it } from "vitest";
import { resolveRetryPrompt } from "./agent";

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
