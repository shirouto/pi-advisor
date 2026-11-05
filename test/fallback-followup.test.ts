import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";

import { resetConfigCache } from "../src/config.ts";
import {
  AdvisorFollowUpCache,
  FOLLOW_UP_MAX_TOOL_CALLS,
  FOLLOW_UP_TTL_MS,
} from "../src/follow-up.ts";
import { AdvisorSessionState } from "../src/session-state.ts";
import { consultAdvisor, registerAdvisorTool } from "../src/tools.ts";
import { withAgentDir } from "./helpers/config-fixture.ts";
import { asExtensionContext } from "./helpers/extension-context.ts";
import { mockPi } from "./helpers/mock-pi.ts";

const fauxContext = (cwd: string, faux: any, model?: string, trusted = false) =>
  asExtensionContext({
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    model: model ? { id: model, provider: "fallback-test" } : undefined,
    modelRegistry: {
      find: (_provider: string, id: string) =>
        faux.models.find((candidate: any) => candidate.id === id),
      getApiKeyAndHeaders: () =>
        Promise.resolve({ apiKey: "key", ok: true as const }),
    },
    sessionManager: { getBranch: () => [] },
  });

const fallbackModels = () =>
  registerFauxProvider({
    api: "fallback-test-api",
    models: [
      { id: "primary", input: ["text"] },
      { id: "fallback", input: ["text"] },
    ],
    provider: "fallback-test",
  });

describe("Advisor fallback model", () => {
  test("retries once and attributes the response to the fallback model", async () => {
    const faux = fallbackModels();

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorFallbackModel: "fallback-test/fallback",
          advisorGitContext: "off",
        },
        async (agentDir) => {
          faux.setResponses([
            () =>
              fauxAssistantMessage("", {
                errorMessage: "primary unavailable",
                stopReason: "error",
              }),
            () => fauxAssistantMessage("Fallback advice"),
          ]);

          const result = await consultAdvisor(
            fauxContext(agentDir, faux),
            "Review this decision."
          );

          expect(result.markdown).toBe("Fallback advice");
          expect(result.model).toBe("fallback-test/fallback");
          expect(faux.state.callCount).toBe(2);
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("counts a fallback retry once against the consultation budget", async () => {
    const faux = fallbackModels();
    const tools = new Map<string, any>();
    const session = new AdvisorSessionState();
    registerAdvisorTool(mockPi({ tools }), session);

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorFallbackModel: "fallback-test/fallback",
          advisorGitContext: "off",
          advisorMaxCallsPerSession: 1,
        },
        async (agentDir) => {
          faux.setResponses([
            () =>
              fauxAssistantMessage("", {
                errorMessage: "primary unavailable",
                stopReason: "error",
              }),
            () => fauxAssistantMessage("Recovered advice"),
          ]);

          const result = await tools
            .get("ask_advisor")
            .execute(
              "call-1",
              {},
              new AbortController().signal,
              undefined,
              fauxContext(agentDir, faux)
            );

          expect(result.details.advisor).toBe("fallback-test/fallback");
          expect(session.consumedCalls).toBe(1);
          expect(session.usageStatus()).toContain("1 call");
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("surfaces an invalid fallback model with the primary failure", async () => {
    const faux = fallbackModels();

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorFallbackModel: "fallback-test/missing",
          advisorGitContext: "off",
        },
        async (agentDir) => {
          faux.setResponses([
            () =>
              fauxAssistantMessage("", {
                errorMessage: "primary unavailable",
                stopReason: "error",
              }),
          ]);
          await expect(
            consultAdvisor(fauxContext(agentDir, faux), "Review this decision.")
          ).rejects.toThrow(/primary unavailable.*fallback-test\/missing/u);
          expect(faux.state.callCount).toBe(1);
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("does not call a fallback that matches the active Executor", async () => {
    const faux = fallbackModels();

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorFallbackModel: "fallback-test/fallback",
          advisorGitContext: "off",
        },
        async (agentDir) => {
          faux.setResponses([
            () =>
              fauxAssistantMessage("", {
                errorMessage: "primary unavailable",
                stopReason: "error",
              }),
          ]);
          await expect(
            consultAdvisor(
              fauxContext(agentDir, faux, "fallback"),
              "Review this decision."
            )
          ).rejects.toThrow("fallback skipped");
          expect(faux.state.callCount).toBe(1);
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("does not retry a cancelled primary request", async () => {
    const faux = fallbackModels();

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorFallbackModel: "fallback-test/fallback",
          advisorGitContext: "off",
        },
        async (agentDir) => {
          const controller = new AbortController();
          faux.setResponses([
            () => {
              controller.abort(new Error("user cancelled"));

              return fauxAssistantMessage("", {
                errorMessage: "cancelled",
                stopReason: "aborted",
              });
            },
            () => fauxAssistantMessage("must not run"),
          ]);
          await expect(
            consultAdvisor(
              fauxContext(agentDir, faux),
              "Review this decision.",
              controller.signal
            )
          ).rejects.toThrow();
          expect(faux.state.callCount).toBe(1);
        }
      );
    } finally {
      faux.unregister();
    }
  });
});

describe("Advisor follow-up payload cache", () => {
  test("reuses the exact original message prefix and marks the result", async () => {
    const faux = fallbackModels();
    const tools = new Map<string, any>();
    const session = new AdvisorSessionState();
    const requests: unknown[] = [];
    registerAdvisorTool(mockPi({ tools }), session);

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorGitContext: "off",
          advisorMaxCallsPerSession: 3,
        },
        async (agentDir) => {
          faux.setResponses([
            (context) => {
              requests.push(structuredClone(context.messages));

              return fauxAssistantMessage("Initial advice");
            },
            (context) => {
              requests.push(structuredClone(context.messages));

              return fauxAssistantMessage("Follow-up advice");
            },
          ]);
          const ctx = fauxContext(agentDir, faux);

          const first = await tools
            .get("ask_advisor")
            .execute(
              "first",
              { question: "Check the migration." },
              new AbortController().signal,
              undefined,
              ctx
            );

          const second = await tools.get("ask_advisor").execute(
            "second",
            {
              followUpTo: first.details.adviceId,
              question: "What edge case did the review miss?",
            },
            new AbortController().signal,
            undefined,
            ctx
          );

          expect(requests).toHaveLength(2);
          // SAFETY: the provider captures the two message arrays for this test.
          expect(requests[1]).toMatchObject([
            ...(requests[0] as any[]),
            {
              content: [
                {
                  text: "Follow-up focus:\nWhat edge case did the review miss?",
                  type: "text",
                },
              ],
              role: "user",
            },
          ]);
          expect(second.details.followUp).toBe(true);
          expect(second.details.advisor).toBe("fallback-test/primary");
          expect(second.structuredContent).toMatchObject({
            adviceId: second.details.adviceId,
            advisor: second.details.advisor,
            followUp: true,
            text: second.details.text,
          });
          expect(second.content[0].text).toContain("Advisor follow-up");
          expect(session.consumedCalls).toBe(2);
          expect(second.details.adviceId).not.toBe(first.details.adviceId);
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("redacts follow-up questions and caches only the redacted prefix", async () => {
    const faux = fallbackModels();
    const tools = new Map<string, any>();
    const session = new AdvisorSessionState();
    const requests: string[] = [];
    registerAdvisorTool(mockPi({ tools }), session);

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorGitContext: "off",
          advisorMaxCallsPerSession: 2,
          advisorRedactSecrets: true,
        },
        async (agentDir) => {
          faux.setResponses([
            (context) => {
              requests.push(JSON.stringify(context.messages));

              return fauxAssistantMessage("Initial advice");
            },
            (context) => {
              requests.push(JSON.stringify(context.messages));

              return fauxAssistantMessage("Follow-up advice");
            },
          ]);
          const ctx = fauxContext(agentDir, faux);

          const first = await tools
            .get("ask_advisor")
            .execute(
              "first",
              { question: "password=original-secret" },
              new AbortController().signal,
              undefined,
              ctx
            );

          await tools.get("ask_advisor").execute(
            "second",
            {
              followUpTo: first.details.adviceId,
              question: "password=follow-up-secret",
            },
            new AbortController().signal,
            undefined,
            ctx
          );
          expect(requests.join("\n")).not.toContain("original-secret");
          expect(requests.join("\n")).not.toContain("follow-up-secret");
          expect(requests.join("\n")).toContain("[REDACTED SECRET]");
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("rejects a follow-up after disclosure settings change", async () => {
    const faux = fallbackModels();
    const tools = new Map<string, any>();
    const session = new AdvisorSessionState();
    registerAdvisorTool(mockPi({ tools }), session);

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorGitContext: "off",
          advisorMaxCallsPerSession: 2,
          advisorRedactSecrets: false,
        },
        async (agentDir) => {
          faux.setResponses([() => fauxAssistantMessage("Initial advice")]);
          const ctx = fauxContext(agentDir, faux);

          const first = await tools
            .get("ask_advisor")
            .execute(
              "first",
              { question: "Review the migration." },
              new AbortController().signal,
              undefined,
              ctx
            );

          writeFileSync(
            join(agentDir, "advisor.json"),
            JSON.stringify({
              advisor: "fallback-test/primary",
              advisorGitContext: "off",
              advisorMaxCallsPerSession: 2,
              advisorRedactSecrets: true,
            })
          );
          resetConfigCache();
          await expect(
            tools.get("ask_advisor").execute(
              "second",
              {
                followUpTo: first.details.adviceId,
                question: "Continue the review.",
              },
              new AbortController().signal,
              undefined,
              ctx
            )
          ).rejects.toThrow("privacy or disclosure settings changed");
          expect(session.consumedCalls).toBe(1);
          expect(faux.state.callCount).toBe(1);
        }
      );
    } finally {
      resetConfigCache();
      faux.unregister();
    }
  });

  test("binds follow-ups to trust, cwd, and disclosure policy", async () => {
    const faux = fallbackModels();

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorGitContext: "off",
          advisorMaxCallsPerSession: 2,
        },
        async (agentDir) => {
          const cases = [
            {
              label: "trust",
              next: fauxContext(agentDir, faux, undefined, true),
            },
            {
              label: "cwd",
              next: fauxContext(`${agentDir}/other`, faux),
            },
            {
              config: {
                advisor: "fallback-test/primary",
                advisorGitContext: "off",
                advisorMaxCallsPerSession: 2,
                advisorToolPolicies: { bash: "exclude" },
                advisorToolResultMaxLines: 1,
              },
              label: "disclosure",
              next: fauxContext(agentDir, faux),
            },
          ];

          for (const item of cases) {
            writeFileSync(
              join(agentDir, "advisor.json"),
              JSON.stringify({
                advisor: "fallback-test/primary",
                advisorGitContext: "off",
                advisorMaxCallsPerSession: 2,
              })
            );
            resetConfigCache();
            const tools = new Map<string, any>();
            const session = new AdvisorSessionState();
            registerAdvisorTool(mockPi({ tools }), session);
            faux.setResponses([() => fauxAssistantMessage("Initial advice")]);

            const first = await tools
              .get("ask_advisor")
              .execute(
                `${item.label}-first`,
                { question: "Review the migration." },
                new AbortController().signal,
                undefined,
                fauxContext(agentDir, faux)
              );

            const callsBeforeFollowUp = faux.state.callCount;

            if (item.config) {
              writeFileSync(
                join(agentDir, "advisor.json"),
                JSON.stringify(item.config)
              );
              resetConfigCache();
            }

            await expect(
              tools.get("ask_advisor").execute(
                `${item.label}-second`,
                {
                  followUpTo: first.details.adviceId,
                  question: "Continue the review.",
                },
                new AbortController().signal,
                undefined,
                item.next
              )
            ).rejects.toThrow("Issue a fresh consultation");
            expect(session.consumedCalls).toBe(1);
            expect(faux.state.callCount).toBe(callsBeforeFollowUp);
          }
        }
      );
    } finally {
      resetConfigCache();
      faux.unregister();
    }
  });

  test("invalidates a cached follow-up after an ordinary tool result", async () => {
    const faux = fallbackModels();
    const tools = new Map<string, any>();
    const events = new Map<string, any>();
    const session = new AdvisorSessionState();
    registerAdvisorTool(mockPi({ events, tools }), session);

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorGitContext: "off",
          advisorMaxCallsPerSession: 2,
        },
        async (agentDir) => {
          faux.setResponses([() => fauxAssistantMessage("Initial advice")]);
          const ctx = fauxContext(agentDir, faux);

          const first = await tools
            .get("ask_advisor")
            .execute("first", {}, new AbortController().signal, undefined, ctx);

          for (let index = 0; index < FOLLOW_UP_MAX_TOOL_CALLS; index += 1) {
            events.get("tool_result")?.({ toolName: "read" });
          }

          await expect(
            tools.get("ask_advisor").execute(
              "second",
              {
                followUpTo: first.details.adviceId,
                question: "Continue the review.",
              },
              new AbortController().signal,
              undefined,
              ctx
            )
          ).rejects.toThrow("Issue a fresh consultation");
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("rejects unknown follow-ups without spending budget", async () => {
    const faux = fallbackModels();
    const tools = new Map<string, any>();
    const session = new AdvisorSessionState();
    registerAdvisorTool(mockPi({ tools }), session);

    try {
      await withAgentDir(
        {
          advisor: "fallback-test/primary",
          advisorGitContext: "off",
          advisorMaxCallsPerSession: 1,
        },
        async (agentDir) => {
          await expect(
            tools
              .get("ask_advisor")
              .execute(
                "unknown",
                { followUpTo: "missing", question: "Continue the review." },
                new AbortController().signal,
                undefined,
                fauxContext(agentDir, faux)
              )
          ).rejects.toThrow("Issue a fresh consultation");
          expect(session.consumedCalls).toBe(0);
          expect(faux.state.callCount).toBe(0);
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("expires and invalidates cached payloads", () => {
    let now = 10_000;
    const cache = new AdvisorFollowUpCache(() => now);

    const payload = {
      depth: 0,
      messages: [],
      model: "provider/advisor",
      privacyKey: "privacy",
      redacted: true,
      systemPrompt: "system",
    };

    cache.capture("advice", payload);

    for (let index = 0; index < FOLLOW_UP_MAX_TOOL_CALLS; index += 1) {
      cache.advanceToolCall();
    }

    expect(cache.get("advice").reason).toContain("unknown");

    cache.capture("advice", payload);
    now += FOLLOW_UP_TTL_MS;
    expect(cache.get("advice").reason).toContain("expired");
  });

  test("caps the follow-up chain depth", () => {
    const cache = new AdvisorFollowUpCache(() => 10_000);
    cache.capture("deep", {
      depth: 3,
      messages: [],
      model: "provider/advisor",
      privacyKey: "privacy",
      redacted: true,
      systemPrompt: "system",
    });
    expect(cache.get("deep").reason).toContain("limited to 3");
  });
});
