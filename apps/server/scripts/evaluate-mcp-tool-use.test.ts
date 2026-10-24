import { assert, it } from "@effect/vitest";

import {
  buildBase,
  buildMessages,
  gradeSample,
  makeSample,
  type SampleRun,
  t3SystemAppend,
} from "./evaluate-mcp-tool-use.ts";
import { taskPrompt } from "../src/mcp/OrchestratorMcpService.ts";
import { mcpToolUseEvaluationCases } from "./mcpToolUseEvaluationCases.ts";
import { makeWorld, runFileTool, runShell } from "./mcpToolUseWorld.ts";

const failed = (expect: Parameters<typeof gradeSample>[0], run: SampleRun) =>
  gradeSample(expect, run)
    .filter((check) => !check.pass)
    .map((check) => check.check);

it("passes a good run and names every rule a bad run breaks", () => {
  const expect = {
    calls: [{ tool: "delegate_task", args: { task: "~FINDING", "target.options": "~max" } }],
    callsMustNot: [{ tool: "delegate_task", args: { runtimeMode: "approval-required" } }],
    notCalls: ["t3_thread_send"],
    order: ["orchestrator_capabilities", "delegate_task"],
    minCalls: { orchestrator_capabilities: 1 },
    maxCalls: { task_status: 0 },
    endsTurnAfter: "delegate_task",
    shellMustNot: ["\\bsleep\\b"],
    textMust: ["t3-thread://v1/"],
    textMustNot: ["Paste .*token"],
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
    text: "Started [Review](t3-thread://v1/11111111-1111-4111-8111-111111111111). Do not paste a token.",
    stopReason: "end_turn",
  };
  assert.deepEqual(failed(expect, good), []);

  const bad: SampleRun = {
    calls: [
      {
        step: 0,
        tool: "delegate_task",
        input: { task: "Review again", runtimeMode: "approval-required" },
      },
      { step: 1, tool: "t3_thread_send", input: {} },
      { step: 2, tool: "Monitor", input: { command: "sleep 60" } },
      { step: 3, tool: "task_status", input: { taskId: "task-1" } },
    ],
    text: "Paste your token here.",
    stopReason: "max_steps",
  };
  assert.deepEqual(failed(expect, bad), [
    'calls delegate_task {"task":"~FINDING","target.options":"~max"}',
    'callsMustNot delegate_task {"runtimeMode":"approval-required"}',
    "notCalls t3_thread_send",
    "order orchestrator_capabilities > delegate_task",
    "minCalls orchestrator_capabilities >= 1",
    "maxCalls task_status <= 0",
    "endsTurnAfter delegate_task",
    "shellMustNot /\\bsleep\\b/",
    "textMust /t3-thread://v1//",
    "textMustNot /Paste .*token/",
  ]);
});

it("bounds numbers and reads target.options in either schema form", () => {
  const expect = {
    calls: [
      { tool: "t3_thread_read", args: { limit: "<=20" } },
      { tool: "delegate_task", args: { "target.options.effort": "max", timeoutMs: ">=60000" } },
    ],
  };
  const run = (limit: unknown, options: unknown, timeoutMs: number): SampleRun => ({
    calls: [
      { step: 0, tool: "t3_thread_read", input: { limit } },
      { step: 0, tool: "delegate_task", input: { target: { options }, timeoutMs } },
    ],
    text: "",
    stopReason: "end_turn",
  });
  assert.deepEqual(failed(expect, run(20, [{ id: "effort", value: "max" }], 60_000)), []);
  assert.deepEqual(failed(expect, run(5, { effort: "max" }, 90_000)), []);
  assert.lengthOf(failed(expect, run(21, [{ id: "effort", value: "high" }], 59_999)), 2);
  assert.lengthOf(failed(expect, run("10", {}, 60_000)), 2);
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
        {
          type: "text",
          text: "<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>",
        },
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

it("rebuilds the template from this checkout and sends a child T3's task prompt", () => {
  const base = buildBase(template, { keepUserInstructions: false });
  const system = base.system.map((block) => String(block.text));
  assert.deepEqual(system.slice(0, 2), [
    "You are Claude Code.",
    `Main prompt.\n\n${t3SystemAppend()}`,
  ]);
  assert.include(system[2], "model named Sonnet 5.5. The exact model ID is claude-sonnet-5-5.");
  const deferred = system[2]?.split("Load them first:\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
  assert.includeMembers(deferred, ["Monitor", "mcp__t3-code__delegate_task"]);
  assert.notInclude(deferred, "mcp__t3-code__retired_tool");
  assert.deepEqual(
    base.reminders.map((block) => block.text),
    ["<system-reminder>\n# currentDate\n</system-reminder>"],
  );

  const child = mcpToolUseEvaluationCases.find(
    (testCase) => testCase.id === "delegated-child-does-not-watch",
  );
  if (child === undefined) throw new Error("Missing delegated child case.");
  const prompt = buildMessages(makeSample(child, base)).at(-1)?.content.at(-1);
  assert.equal(prompt?.text, taskPrompt({ task: child.prompt, role: "implementation" }));
  assert.notEqual(prompt?.text, child.prompt);
});

it("answers shell and file tools from the case's fake world", () => {
  const world = makeWorld(
    {
      branch: "fix/socket",
      branches: { "fix/base": "abc1234" },
      commits: [
        { sha: "def5678", subject: "fix(web): keep a healthy socket" },
        { sha: "abc1234", subject: "fix(web): add socket state" },
      ],
      diff: "diff --git a/src/socket.ts b/src/socket.ts\n--- a/src/socket.ts\n+++ b/src/socket.ts\n@@ -1 +1 @@\n-old\n+new\n",
      files: { "docs/plan.md": "# Plan\n- lane D\n" },
      prs: [{ number: 123, title: "fix(ws): backoff", headRefName: "fix/ws-backoff" }],
      pages: { "https://docs.acme.test": "<h1>Docs</h1>" },
    },
    { cwd: "/repo", platform: "linux" },
  );
  const mocks = [{ match: "^gh pr checks", output: "Check\tpending" }];
  const shell = (command: string) => runShell(world, mocks, command).text;
  assert.equal(shell("cd docs && pwd; git branch --show-current"), "/repo/docs\nfix/socket");
  assert.equal(
    shell("git log --oneline fix/base..HEAD | head -5"),
    "def5678 fix(web): keep a healthy socket",
  );
  assert.equal(shell("git log --oneline HEAD..origin/main"), "(Bash completed with no output)");
  assert.equal(shell("cat src/socket.ts || grep -n lane docs/plan.md"), "new");
  assert.equal(
    shell("cat nope.md || grep -n lane docs/plan.md"),
    "cat: nope.md: No such file or directory\ndocs/plan.md:2:- lane D",
  );
  assert.equal(
    shell("git push -u origin HEAD 2>&1 && gh pr checks"),
    "To github.com:acme/app.git\n * [new branch]      fix/socket -> fix/socket\nCheck\tpending",
  );
  assert.equal(
    shell('gh pr create --title "fix: socket" --body "a; b && c"'),
    "https://github.com/acme/app/pull/124",
  );
  assert.equal(shell("gh pr view --json number,headRefName --jq .headRefName"), "fix/socket");
  assert.equal(
    shell("curl -s https://docs.acme.test/start -o /tmp/p.html -w '%{http_code}'; cat /tmp/p.html"),
    "200\n<h1>Docs</h1>",
  );
  assert.deepEqual(runShell(world, [], "ls missing"), {
    text: "Exit code 1\nls: cannot access 'missing': No such file or directory",
    error: true,
  });

  assert.isFalse(
    runFileTool(world, "Edit", { file_path: "docs/plan.md", old_string: "D", new_string: "E" })
      ?.error,
  );
  assert.equal(
    runFileTool(world, "Read", { file_path: "/repo/docs/plan.md" })?.text,
    "     1\t# Plan\n     2\t- lane E",
  );
  assert.match(
    shell("git commit -am 'docs: rename lane'; git status --short"),
    /^\[fix\/socket \w{7}\] docs: rename lane/,
  );
});
