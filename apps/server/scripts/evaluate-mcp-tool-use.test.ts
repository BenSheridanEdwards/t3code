import { assert, it } from "@effect/vitest";

import {
  answerToolCall,
  buildBase,
  buildMessages,
  gradeSample,
  initialState,
  type SampleRun,
  t3SystemAppend,
} from "./evaluate-mcp-tool-use.ts";
import { mcpToolUseEvaluationCases } from "./mcpToolUseEvaluationCases.ts";

const failed = (expect: Parameters<typeof gradeSample>[0], run: SampleRun) =>
  gradeSample(expect, run)
    .filter((check) => !check.pass)
    .map((check) => check.check);

it("passes a good run and names every rule a bad run breaks", () => {
  const expect = {
    calls: [{ tool: "delegate_task", args: { task: "~FINDING", "target.options": "~max" } }],
    notCalls: ["t3_thread_send"],
    order: ["orchestrator_capabilities", "delegate_task"],
    maxCalls: { task_status: 0 },
    endsTurnAfter: "delegate_task",
    shellMustNot: ["\\bsleep\\b"],
    textMust: ["t3-thread://v1/"],
    textMustNot: ["paste .*token"],
  };
  const good: SampleRun = {
    calls: [
      { step: 0, tool: "orchestrator_capabilities", input: {} },
      {
        step: 1,
        tool: "delegate_task",
        input: { task: "Prior findings: ...", target: { options: { reasoningEffort: "max" } } },
      },
    ],
    text: "Started [Review](t3-thread://v1/11111111-1111-4111-8111-111111111111).",
    stopReason: "end_turn",
  };
  assert.deepEqual(failed(expect, good), []);

  const bad: SampleRun = {
    calls: [
      { step: 0, tool: "delegate_task", input: { task: "Review again", target: { options: [] } } },
      { step: 0, tool: "orchestrator_capabilities", input: {} },
      { step: 1, tool: "t3_thread_send", input: {} },
      { step: 2, tool: "Bash", input: { command: "sleep 60" } },
      { step: 3, tool: "task_status", input: { taskId: "task-1" } },
    ],
    text: "Paste your token here.",
    stopReason: "max_steps",
  };
  assert.deepEqual(failed(expect, bad), [
    'calls delegate_task {"task":"~FINDING","target.options":"~max"}',
    "notCalls t3_thread_send",
    "order orchestrator_capabilities > delegate_task",
    "maxCalls task_status <= 0",
    "endsTurnAfter delegate_task",
    "shellMustNot /\\bsleep\\b/",
    "textMust /t3-thread://v1//",
    "textMustNot /paste .*token/",
  ]);
});

const template = {
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=1;" },
    { type: "text", text: "You are Claude Code." },
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>\n# currentDate\n</system-reminder>" },
        { type: "text", text: "<system-reminder>\n# gitStatus\nmain\n</system-reminder>" },
        { type: "text", text: "The captured prompt." },
      ],
    },
    {
      role: "system",
      content:
        "Main prompt.\n\n<runtime_info>old</runtime_info>\n\n## T3 Code orchestration\nold text",
    },
    {
      role: "system",
      content:
        "You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.\n\nThe following deferred tools are now available via ToolSearch. Load them first:\nMonitor\nmcp__t3-code__retired_tool\n\nAfter the list.",
    },
    { role: "assistant", content: [{ type: "text", text: "A later turn." }] },
  ],
  tools: [
    { name: "mcp__host__term_Bash", input_schema: { type: "object" } },
    { name: "mcp__host__clown_ToolSearch", input_schema: { type: "object" } },
    { name: "mcp__t3-code__retired_tool", input_schema: { type: "object" }, defer_loading: true },
  ],
};

it("rebuilds the template with T3 text and tools from this checkout", () => {
  const append = t3SystemAppend();
  const base = buildBase(template, { deferT3: true, keepUserInstructions: true }, append);
  const system = base.system.map((block) => String(block.text));

  assert.deepEqual(system.slice(0, 2), ["You are Claude Code.", `Main prompt.\n\n${append}`]);
  assert.include(append, "## T3 Code orchestration");
  assert.include(system[2], "model named Sonnet 5.5. The exact model ID is claude-sonnet-5-5.");
  const deferred = system[2]?.split("Load them first:\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
  assert.include(deferred, "Monitor");
  assert.include(deferred, "mcp__t3-code__delegate_task");
  assert.notInclude(deferred, "mcp__t3-code__retired_tool");
  assert.include(system[2], "\n\nAfter the list.");
  assert.deepEqual(base.reminders, [
    { type: "text", text: "<system-reminder>\n# currentDate\n</system-reminder>" },
  ]);
  assert.deepEqual(
    base.nativeTools.map((tool) => tool.name),
    ["mcp__host__term_Bash", "mcp__host__clown_ToolSearch"],
  );
});

it("loads a T3 tool through ToolSearch before a prior turn or a new call uses it", () => {
  const base = buildBase(template, { deferT3: true, keepUserInstructions: true }, t3SystemAppend());
  const reviewRound = mcpToolUseEvaluationCases.find(
    (testCase) => testCase.id === "review-round-uses-thread-send",
  );
  if (reviewRound === undefined) throw new Error("Missing review round case.");
  const state = initialState(base, "high");
  const messages = buildMessages(reviewRound, base, state);
  assert.deepEqual(
    messages.map((message) => message.content.map((block) => block.name ?? block.type)),
    [
      ["text", "text"],
      ["mcp__host__clown_ToolSearch"],
      ["tool_result", "text"],
      ["mcp__t3-code__delegate_task"],
      ["tool_result"],
      ["text"],
      ["text"],
    ],
  );

  const call = {
    type: "tool_use",
    id: "toolu_1",
    name: "mcp__t3-code__watch_pull_request",
  } as const;
  const watch = { ...call, input: { url: "https://github.com/acme/app/pull/123" } };
  assert.isTrue(answerToolCall(watch, reviewRound, base, state).result.is_error);
  const search = {
    type: "tool_use",
    id: "toolu_2",
    name: "mcp__host__clown_ToolSearch",
    input: { query: "select:watch_pull_request", max_results: 1 },
  } as const;
  const loaded = answerToolCall(search, reviewRound, base, state);
  assert.deepEqual(loaded.result.content, [
    { type: "tool_reference", tool_name: "mcp__t3-code__watch_pull_request" },
  ]);
  assert.equal(loaded.note, "Tool loaded.");
  assert.isUndefined(answerToolCall(watch, reviewRound, base, state).result.is_error);
});
