import { OrchestratorMcpTaskRole } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const PriorToolCall = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  result: Schema.Unknown,
});

/**
 * One expected call. `args` match partially: `~text` is a case-insensitive substring,
 * `"<=N"` / `">=N"` bound a number, and keys may be dotted paths.
 */
const McpToolUseCall = Schema.Struct({
  tool: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type McpToolUseCall = typeof McpToolUseCall.Type;

/** Grading rules. Tool names are bare: `delegate_task`, `Bash`, `Agent`. */
export const McpToolUseExpect = Schema.Struct({
  /** Each entry needs one matching call. */
  calls: Schema.optional(Schema.Array(McpToolUseCall)),
  /** No call may match any entry. */
  callsMustNot: Schema.optional(Schema.Array(McpToolUseCall)),
  notCalls: Schema.optional(Schema.Array(Schema.String)),
  /** First calls of these tools happen in this order. */
  order: Schema.optional(Schema.Array(Schema.String)),
  minCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  maxCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  /** The last step with tool calls includes this tool, then the turn ends. */
  endsTurnAfter: Schema.optional(Schema.String),
  /** Regexes that no shell command may match. */
  shellMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Case-sensitive regexes on the agent's visible text. */
  textMust: Schema.optional(Schema.Array(Schema.String)),
  textMustNot: Schema.optional(Schema.Array(Schema.String)),
});

/** One fake thread. The format is described in the eval brief; private cases use it as JSONL. */
export const McpToolUseCase = Schema.Struct({
  id: Schema.String,
  area: Schema.String,
  kind: Schema.Literals(["bad", "guard", "control"]),
  pattern: Schema.String,
  experience: Schema.String,
  rule: Schema.optional(Schema.String),
  privacy: Schema.optional(Schema.Literals(["commit-safe", "private"])),
  setup: Schema.Struct({
    role: Schema.Literals(["top", "delegated-child", "native-subagent"]),
    /** delegate_task `role` for a delegated child. T3 builds the child's first message from it. */
    delegateRole: Schema.optional(OrchestratorMcpTaskRole),
    context: Schema.optional(Schema.String),
    priorTurns: Schema.optional(
      Schema.Array(
        Schema.Struct({
          role: Schema.Literals(["user", "assistant"]),
          text: Schema.optional(Schema.String),
          toolCalls: Schema.optional(Schema.Array(PriorToolCall)),
        }),
      ),
    ),
    /** Canned T3 tool results by bare name. `"default"` uses the runner's generic result. */
    mocks: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    shellMocks: Schema.optional(
      Schema.Array(Schema.Struct({ match: Schema.String, output: Schema.String })),
    ),
  }),
  prompt: Schema.String,
  expect: McpToolUseExpect,
  source: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  notes: Schema.optional(Schema.String),
});
export type McpToolUseCase = typeof McpToolUseCase.Type;

const exampleSource = {
  observed: "example",
  evidence: "Runner example written from the T3 instruction rule, not from one thread.",
};

export const mcpToolUseEvaluationCases: ReadonlyArray<McpToolUseCase> = [
  {
    id: "review-round-uses-thread-send",
    area: "orchestration",
    kind: "bad",
    pattern: "review round sent to childThreadId",
    experience: "A follow-up review round went to the old child thread instead of a new task.",
    rule: "Do not use t3_thread_send on childThreadId to continue a delegated review.",
    privacy: "commit-safe",
    setup: {
      role: "top",
      priorTurns: [
        { role: "user", text: "Have a Codex delegate review the diff on this branch." },
        {
          role: "assistant",
          text: "The Codex review found 2 issues: the retry loop never stops, and the cache key ignores the user id.",
          toolCalls: [
            {
              tool: "delegate_task",
              input: {
                task: "Review the diff on this branch against main. Report correctness bugs.",
                target: { providerInstanceId: "codex", model: "gpt-6-astra" },
                mode: "wait",
              },
              result: {
                taskId: "task-1",
                childThreadId: "11111111-1111-4111-8111-111111111111",
                status: "completed",
                summary:
                  "2 findings: 1) the retry loop in sync.ts never stops on 4xx. 2) the cache key in cache.ts ignores the user id.",
              },
            },
          ],
        },
      ],
    },
    prompt: "Fixed both. Do another review round.",
    expect: {
      calls: [{ tool: "delegate_task", args: { task: "~retry" } }],
      notCalls: ["t3_thread_send"],
    },
    source: exampleSource,
  },
  {
    id: "async-delegate-ends-turn",
    area: "orchestration",
    kind: "bad",
    pattern: "polls after async delegate_task",
    experience: "After an async delegate_task, the agent polled with sleep and task_status.",
    rule: "An async child's completion wakes this thread, so end the turn instead of polling.",
    privacy: "commit-safe",
    setup: { role: "top", mocks: { orchestrator_capabilities: "default" } },
    prompt: "Have a Codex agent review the diff on this branch with max reasoning effort.",
    expect: {
      calls: [
        {
          tool: "delegate_task",
          args: { "target.providerInstanceId": "codex", "target.options.reasoningEffort": "max" },
        },
      ],
      order: ["orchestrator_capabilities", "delegate_task"],
      notCalls: ["task_status", "t3_thread_launch", "create_threads"],
      endsTurnAfter: "delegate_task",
      shellMustNot: ["\\bsleep\\b"],
    },
    source: exampleSource,
  },
  {
    id: "babysit-pr-uses-watch",
    area: "pull-requests",
    kind: "guard",
    pattern: "babysit with watch_pull_request",
    experience: "Asked to babysit a PR, the agent must watch it and end the turn.",
    rule: "When asked to monitor, watch, or babysit a PR, call watch_pull_request and end your turn.",
    privacy: "commit-safe",
    setup: {
      role: "top",
      context: "This thread already has PR https://github.com/acme/app/pull/123 linked.",
    },
    prompt: "Babysit the PR until it is green.",
    expect: {
      calls: [{ tool: "watch_pull_request" }],
      endsTurnAfter: "watch_pull_request",
      shellMustNot: ["\\bsleep\\b", "gh pr checks .*--watch"],
    },
    source: exampleSource,
  },
  {
    id: "delegated-child-does-not-watch",
    area: "pull-requests",
    kind: "guard",
    pattern: "delegated child watches PR",
    experience: "A delegated child must link its PR and report back, not watch it.",
    rule: "As a delegated child task, do not watch or poll PRs.",
    privacy: "commit-safe",
    setup: {
      role: "delegated-child",
      delegateRole: "implementation",
      shellMocks: [
        { match: "gh pr create", output: "https://github.com/acme/app/pull/124" },
        {
          match: "git push",
          output: "branch 'fix/date-format' set up to track 'origin/fix/date-format'.",
        },
      ],
    },
    prompt:
      "The fix is committed on branch fix/date-format. Push it, open a PR against main, and report the PR URL.",
    expect: {
      calls: [{ tool: "link_pull_request" }],
      notCalls: ["watch_pull_request"],
      shellMustNot: ["\\bsleep\\b", "--watch"],
    },
    source: exampleSource,
  },
  {
    id: "plain-rename-needs-no-t3-tools",
    area: "control",
    kind: "control",
    pattern: "ordinary coding task",
    experience: "An ordinary edit needs no T3 tools.",
    rule: "none",
    privacy: "commit-safe",
    setup: {
      role: "top",
      shellMocks: [
        {
          match: "\\b(rg|grep|git grep)\\b",
          output:
            "src/utils/date.ts:3:export function formatDate(value: Date) {\nsrc/app.ts:1:import { formatDate } from './utils/date';",
        },
      ],
    },
    prompt: "Rename formatDate in src/utils/date.ts to formatIsoDate and update its imports.",
    expect: {
      notCalls: ["delegate_task", "t3_thread_launch", "create_threads", "Agent", "ToolSearch"],
    },
    source: exampleSource,
  },
];
