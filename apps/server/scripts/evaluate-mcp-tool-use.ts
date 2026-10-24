#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Replays small fake threads against Claude Sonnet 5.5 to check how agents use
 * T3 Code's MCP tools. A captured Claude Code request supplies the real system
 * prompt, reminders, and native tools. The T3 instructions and tool schemas come
 * from this checkout, so running two branches A/B tests an instruction rewrite.
 *
 *   node scripts/evaluate-mcp-tool-use.ts --template <capture.json> --out <dir> [--cases <file.jsonl>]...
 *   node scripts/evaluate-mcp-tool-use.ts --template <capture.json> --dry-run --case <id>
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { AttachmentToolkit } from "../src/mcp/toolkits/attachment/tools.ts";
import { DeviceScreenshotTool, DeviceToolkit } from "../src/mcp/toolkits/device/tools.ts";
import { EnvironmentToolkit } from "../src/mcp/toolkits/environment/tools.ts";
import { HtmlPreviewTool, HtmlToolkit } from "../src/mcp/toolkits/html/tools.ts";
import { OrchestratorToolkit } from "../src/mcp/toolkits/orchestrator/tools.ts";
import { PreviewSnapshotTool, PreviewToolkit } from "../src/mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../src/mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../src/mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../src/mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../src/mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../src/mcp/toolkits/worktree/tools.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { McpToolUseCase, mcpToolUseEvaluationCases } from "./mcpToolUseEvaluationCases.ts";

const MODEL = "claude-sonnet-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// USD per million tokens. Cache writes use the 5-minute rate.
const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
const T3_PREFIX = "mcp__t3-code__";
const RUNTIME_MARKER = "<runtime_info>";
const DEFERRED_LIST =
  /(The following deferred tools are now available via ToolSearch\.[^\n]*\n)((?:[^\n]+\n)*)/;

type Block = { readonly type: string; readonly [key: string]: unknown };
type ApiMessage = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };
type ApiTool = { readonly name: string; readonly [key: string]: unknown };
type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
export interface SampleRun {
  readonly calls: ReadonlyArray<{
    readonly step: number;
    readonly tool: string;
    readonly input: unknown;
  }>;
  readonly text: string;
  readonly stopReason: string;
}

const AnyBlock = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const Content = Schema.Union([Schema.String, Schema.Array(AnyBlock)]);
const MessagesRequest = Schema.Struct({
  system: Schema.optional(Content),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })),
  tools: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
});
// A CLIProxyAPI capture keeps the Anthropic body at request.provider_native.
const Template = Schema.Union([
  Schema.Struct({ request: Schema.Struct({ provider_native: MessagesRequest }) }),
  MessagesRequest,
]);
const ToolUse = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
const isToolUse = Schema.is(ToolUse);
const isText = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const OptionalCount = Schema.optional(Schema.NullOr(Schema.Number));
const ApiResponse = Schema.Struct({
  content: Schema.Array(AnyBlock),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_creation_input_tokens: OptionalCount,
    cache_read_input_tokens: OptionalCount,
  }),
});

const text = (value: string): Block => ({ type: "text", text: value });
const reminder = (value: string) => text(`<system-reminder>\n${value}\n</system-reminder>`);
const toolResult = (id: string, content: unknown, isError = false): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: typeof content === "string" ? content : JSON.stringify(content),
  ...(isError ? { is_error: true } : {}),
});
const texts = (content: typeof Content.Type) =>
  typeof content === "string" ? [content] : content.flatMap((block) => block.text ?? []);
const isT3Name = (name: string) => name.startsWith(T3_PREFIX) || name.startsWith("mcp__t3_code__");

/** Grading name: T3 tools lose their MCP prefix, native tools keep the part after the last `_`. */
export const normalizeToolName = (name: string) =>
  isT3Name(name) ? name.slice(T3_PREFIX.length) : name.slice(name.lastIndexOf("_") + 1);

// McpHttpServer registers toolkits through decodeAsAdvertised and McpServer.registerToolkit,
// which advertise each schema's JSON codec. The three image tools register by hand from the
// plain schema. Claude Code passes the MCP name, description, and schema through unchanged.
const handRegistered = new Set([
  PreviewSnapshotTool.name,
  DeviceScreenshotTool.name,
  HtmlPreviewTool.name,
]);
export const t3Tools: ReadonlyArray<ApiTool> = [
  OrchestratorToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  WorktreeToolkit,
  PullRequestsToolkit,
  PreviewToolkit,
  DeviceToolkit,
  HtmlToolkit,
]
  .flatMap((toolkit): ReadonlyArray<Tool.Any> => Object.values(toolkit.tools))
  .map((tool) => ({
    name: `${T3_PREFIX}${tool.name}`,
    description: Tool.getDescription(tool) ?? "",
    input_schema: handRegistered.has(tool.name)
      ? Tool.getJsonSchema(tool)
      : Schema.toJsonSchemaDocument(Schema.toCodecJson(tool.parametersSchema), {
          onExcessProperty: "ignore",
        }).schema,
  }));

/** Text T3 appends to Claude Code's system prompt. Delegated children get the same text. */
export const t3SystemAppend = () => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: { instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER), model: MODEL },
    nativeThreadId: "mcp-tool-use-eval",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  const append =
    typeof systemPrompt === "object" &&
    !Array.isArray(systemPrompt) &&
    systemPrompt.type === "preset"
      ? systemPrompt.append
      : undefined;
  if (append === undefined) {
    throw new Error("makeClaudeQueryOptions no longer appends T3 text to a preset prompt.");
  }
  return append;
};

export interface Base {
  readonly system: ReadonlyArray<Block>;
  readonly reminders: ReadonlyArray<Block>;
  readonly nativeTools: ReadonlyArray<ApiTool>;
  /** Native tools Claude Code only names. Their schemas are not captured, so they load open. */
  readonly nativeDeferred: ReadonlyArray<ApiTool>;
  readonly deferT3: boolean;
}

/** Rebuilds the parts of a captured request that every case shares. */
export const buildBase = (
  template: typeof MessagesRequest.Type,
  options: { readonly deferT3: boolean; readonly keepUserInstructions: boolean },
  t3Append: string,
): Base => {
  const firstAssistant = template.messages.findIndex((message) => message.role === "assistant");
  const head =
    firstAssistant === -1 ? template.messages : template.messages.slice(0, firstAssistant);
  const systemTexts = [
    ...(template.system === undefined ? [] : texts(template.system)),
    ...head.flatMap((message) => (message.role === "system" ? texts(message.content) : [])),
  ].filter((value) => !value.startsWith("x-anthropic-billing-header:"));
  if (systemTexts.filter((value) => value.includes(RUNTIME_MARKER)).length !== 1) {
    throw new Error(`The template must hold exactly one T3 ${RUNTIME_MARKER} block.`);
  }
  const deferredList = systemTexts.join("\n").match(DEFERRED_LIST)?.[2];
  if (deferredList === undefined && options.deferT3) {
    throw new Error("The template has no deferred tool list. Use --t3-tools inline.");
  }
  const nativeDeferred = (deferredList ?? "")
    .split("\n")
    .filter((name) => name !== "" && !isT3Name(name));
  const deferredNames = [...nativeDeferred, ...(options.deferT3 ? t3Tools.map((t) => t.name) : [])];
  const system = systemTexts.map((value) =>
    // T3's append is the tail of its block: runtime info, PR linking, then orchestration.
    (value.includes(RUNTIME_MARKER)
      ? value.slice(0, value.indexOf(RUNTIME_MARKER)) + t3Append
      : value
    )
      .replace(
        DEFERRED_LIST,
        (_, header: string) => `${header}${deferredNames.toSorted().join("\n")}\n`,
      )
      .replace(
        /You are powered by the model named .+?\. The exact model ID is [\w.-]+\./,
        `You are powered by the model named Sonnet 5.5. The exact model ID is ${MODEL}.`,
      ),
  );
  const first = template.messages[0];
  // The last block is the captured prompt. gitStatus names a real repo state.
  const reminders = (
    first?.role === "user" && typeof first.content !== "string" ? first.content : []
  )
    .slice(0, -1)
    .flatMap((block) => block.text ?? [])
    .filter(
      (value) =>
        !value.includes("# gitStatus") &&
        (options.keepUserInstructions ||
          !value.includes("Codebase and user instructions are shown below")),
    );
  return {
    system: system.map(text),
    reminders: reminders.map(text),
    nativeTools: template.tools.filter((tool) => !isT3Name(tool.name)),
    nativeDeferred: nativeDeferred.map((name) => ({
      name,
      description: `${name} (Claude Code built-in tool)`,
      input_schema: { type: "object", additionalProperties: true },
    })),
    deferT3: options.deferT3,
  };
};

/** Tools sent with the next request. ToolSearch adds to it, like Claude Code. */
export interface SampleState {
  readonly tools: Array<ApiTool>;
  readonly effort: string;
  delegations: number;
}

export const initialState = (base: Base, effort: string): SampleState => ({
  tools: [...base.nativeTools, ...(base.deferT3 ? [] : t3Tools)],
  effort,
  delegations: 0,
});
const hasTool = (state: SampleState, name: string) =>
  state.tools.some((tool) => tool.name === name);
const findTool = (base: Base, bare: string) =>
  [...t3Tools, ...base.nativeTools, ...base.nativeDeferred].find(
    (tool) => tool.name === bare || normalizeToolName(tool.name) === bare,
  );
/** Loads deferred schemas and returns the ToolSearch result Claude Code sends for them. */
const loadTools = (state: SampleState, id: string, tools: ReadonlyArray<ApiTool>): Block => {
  for (const tool of tools) {
    if (!hasTool(state, tool.name)) state.tools.push({ ...tool, defer_loading: true });
  }
  const content = tools.map((tool) => ({ type: "tool_reference", tool_name: tool.name }));
  return { type: "tool_result", tool_use_id: id, content };
};

/** Messages for a case: reminders, context, prior turns with real tool blocks, then the prompt. */
export const buildMessages = (testCase: McpToolUseCase, base: Base, state: SampleState) => {
  const messages: Array<ApiMessage> = [];
  const push = (role: ApiMessage["role"], blocks: ReadonlyArray<Block>) => {
    const last = messages.at(-1);
    if (last?.role !== role) messages.push({ role, content: blocks });
    else messages[messages.length - 1] = { role, content: [...last.content, ...blocks] };
  };
  const { role, context, priorTurns = [] } = testCase.setup;
  push("user", [
    ...base.reminders,
    ...(role === "native-subagent"
      ? [
          reminder(
            "You are a subagent started by the parent agent's Agent tool. Your final message goes to the parent agent, not to the user.",
          ),
        ]
      : []),
    ...(context === undefined ? [] : [reminder(context)]),
  ]);
  const toolSearch = findTool(base, "ToolSearch");
  let nextId = 0;
  for (const turn of priorTurns) {
    const calls = (turn.role === "assistant" ? (turn.toolCalls ?? []) : []).map((call) => ({
      ...call,
      tool: findTool(base, call.tool) ?? { name: call.tool, input_schema: { type: "object" } },
    }));
    const unloaded = [...new Set(calls.map((call) => call.tool))].filter(
      (tool) => !hasTool(state, tool.name),
    );
    if (unloaded.length > 0 && toolSearch !== undefined && base.deferT3) {
      const id = `toolu_prior_${nextId++}`;
      const query = `select:${unloaded.map((tool) => tool.name).join(",")}`;
      const input = { query, max_results: unloaded.length };
      push("assistant", [{ type: "tool_use", id, name: toolSearch.name, input }]);
      push("user", [loadTools(state, id, unloaded), text("Tool loaded.")]);
    } else {
      state.tools.push(...unloaded);
    }
    const ids = calls.map(() => `toolu_prior_${nextId++}`);
    if (calls.length > 0) {
      push(
        "assistant",
        calls.map((call, i) => ({
          type: "tool_use",
          id: ids[i],
          name: call.tool.name,
          input: call.input,
        })),
      );
      push(
        "user",
        calls.map((call, i) => toolResult(ids[i] ?? "", call.result)),
      );
    }
    if (turn.text !== undefined && turn.text !== "") push(turn.role, [text(turn.text)]);
  }
  push("user", [text(testCase.prompt)]);
  return messages;
};

// Model ids already public in this repo's model catalog.
const defaultCapabilities = (effort: string) => {
  const models = (options: ReadonlyArray<object>, ...ids: ReadonlyArray<string>) =>
    ids.map((id) => ({ id, options }));
  const provider = (id: string, displayName: string, models: ReadonlyArray<object>) => ({
    providerInstanceId: id,
    driverKind: id,
    displayName,
    models,
    canRunChildTask: true,
    canRunCrossProviderChildTask: true,
  });
  return {
    parentThreadId: "11111111-1111-4111-8111-111111111111",
    inheritedProviderInstanceId: "claudeAgent",
    inheritedModel: MODEL,
    inheritedOptions: [{ id: "effort", value: effort }],
    runtimeMode: "full-access",
    interactionMode: "default",
    providers: [
      provider("claudeAgent", "Claude", [
        ...models(
          [
            { id: "effort", values: EFFORTS },
            { id: "fastMode", values: [false, true] },
          ],
          "claude-opus-5-5",
        ),
        ...models([{ id: "effort", values: EFFORTS }], MODEL, "claude-haiku-5-5"),
      ]),
      provider(
        "codex",
        "Codex",
        models(
          [
            { id: "reasoningEffort", values: EFFORTS },
            { id: "serviceTier", values: ["default", "priority"] },
          ],
          "gpt-6-astra",
          "gpt-6.1-sol",
        ),
      ),
    ],
  };
};

const t3Result = (testCase: McpToolUseCase, name: string, input: unknown, state: SampleState) => {
  const mock = testCase.setup.mocks?.[name];
  if (mock !== undefined && mock !== "default") return mock;
  if (name === "orchestrator_capabilities") return defaultCapabilities(state.effort);
  if (name !== "delegate_task") return { ok: true };
  const n = ++state.delegations;
  const target = isRecord(input) && isRecord(input.target) ? input.target : {};
  return {
    taskId: `task-eval-${n}`,
    childThreadId: `thread-eval-child-${n}`,
    childRunId: `run-eval-child-${n}`,
    status: "running",
    workState: "working",
    providerInstanceId: target.providerInstanceId ?? "claudeAgent",
    model: target.model ?? MODEL,
    ...(target.options === undefined ? {} : { options: target.options }),
    summary: null,
    hasPendingQuestion: false,
    pendingApproval: null,
  };
};

/** Emulates ToolSearch over deferred tools: `select:a,b`, or keywords that must all match. */
const searchTools = (query: string, max: number, base: Base) => {
  const candidates = [...(base.deferT3 ? t3Tools : []), ...base.nativeDeferred];
  if (query.startsWith("select:")) {
    return query
      .slice("select:".length)
      .split(",")
      .flatMap((name) =>
        candidates.filter((tool) =>
          [tool.name, normalizeToolName(tool.name)].includes(name.trim()),
        ),
      );
  }
  const terms = query.toLowerCase().replaceAll("+", "").split(/\s+/).filter(Boolean);
  const nameHits = (tool: ApiTool) =>
    terms.filter((term) => tool.name.toLowerCase().includes(term)).length;
  return candidates
    .filter((tool) => {
      const haystack = `${tool.name} ${String(tool.description)}`.toLowerCase();
      return terms.length > 0 && terms.every((term) => haystack.includes(term));
    })
    .toSorted((left, right) => nameHits(right) - nameHits(left))
    .slice(0, max);
};

const NATIVE_RESULTS: Readonly<Record<string, string>> = {
  Agent: "The agent finished. Summary: the task is done and nothing else needs attention.",
  Bash: "(Bash completed with no output)",
};

/** Canned result for one tool call. `note` is text Claude Code adds after the results. */
export const answerToolCall = (
  call: typeof ToolUse.Type,
  testCase: McpToolUseCase,
  base: Base,
  state: SampleState,
): { readonly result: Block; readonly note?: string } => {
  const name = normalizeToolName(call.name);
  const input = isRecord(call.input) ? call.input : {};
  if (isT3Name(call.name) && !hasTool(state, call.name)) {
    const error = `InputValidationError: ${call.name} is deferred. Load it with ToolSearch first.`;
    return { result: toolResult(call.id, `<tool_use_error>${error}</tool_use_error>`, true) };
  }
  if (isT3Name(call.name))
    return { result: toolResult(call.id, t3Result(testCase, name, call.input, state)) };
  if (name === "ToolSearch") {
    const max = typeof input.max_results === "number" ? input.max_results : 5;
    const found = searchTools(typeof input.query === "string" ? input.query : "", max, base);
    return found.length === 0
      ? { result: toolResult(call.id, "No matching deferred tools found") }
      : { result: loadTools(state, call.id, found), note: "Tool loaded." };
  }
  const command = typeof input.command === "string" ? input.command : "";
  const shell = testCase.setup.shellMocks?.find((mock) => new RegExp(mock.match).test(command));
  if (name === "Bash" && shell !== undefined) return { result: toolResult(call.id, shell.output) };
  if (name === "Skill")
    return { result: toolResult(call.id, `Launching skill: ${String(input.skill)}`) };
  return { result: toolResult(call.id, NATIVE_RESULTS[name] ?? "OK") };
};

const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
/** Partial match. `~text` is a case-insensitive substring; record keys may be dotted paths. */
const matches = (expected: unknown, actual: unknown): boolean => {
  if (typeof expected === "string" && expected.startsWith("~")) {
    return valueText(actual).toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.every((item) => actual.some((entry) => matches(item, entry)))
    );
  }
  if (!isRecord(expected)) return expected === actual;
  return Object.entries(expected).every(([path, value]) =>
    matches(
      value,
      path.split(".").reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), actual),
    ),
  );
};

export const gradeSample = (expect: McpToolUseCase["expect"], run: SampleRun) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const names = run.calls.map((call) => call.tool);
  const count = (tool: string) => names.filter((name) => name === tool).length;
  const shell = run.calls.flatMap((call) =>
    call.tool === "Bash" && isRecord(call.input) ? valueText(call.input.command) : [],
  );
  for (const { tool, args } of expect.calls ?? []) {
    const label = args === undefined ? tool : `${tool} ${JSON.stringify(args)}`;
    add(
      `calls ${label}`,
      run.calls.some((call) => call.tool === tool && matches(args ?? {}, call.input)),
    );
  }
  for (const tool of expect.notCalls ?? []) add(`notCalls ${tool}`, count(tool) === 0);
  if (expect.order !== undefined) {
    const firsts = expect.order.map((tool) => names.indexOf(tool));
    add(
      `order ${expect.order.join(" > ")}`,
      firsts.every((at, i) => at > (firsts[i - 1] ?? -1)),
    );
  }
  for (const [tool, max] of Object.entries(expect.maxCalls ?? {})) {
    add(`maxCalls ${tool} <= ${max}`, count(tool) <= max);
  }
  if (expect.endsTurnAfter !== undefined) {
    const lastStep = Math.max(-1, ...run.calls.map((call) => call.step));
    const last = run.calls.filter((call) => call.step === lastStep).map((call) => call.tool);
    add(
      `endsTurnAfter ${expect.endsTurnAfter}`,
      run.stopReason === "end_turn" && last.includes(expect.endsTurnAfter),
    );
  }
  for (const pattern of expect.shellMustNot ?? []) {
    add(`shellMustNot /${pattern}/`, !shell.some((command) => new RegExp(pattern).test(command)));
  }
  for (const pattern of expect.textMust ?? [])
    add(`textMust /${pattern}/`, new RegExp(pattern, "i").test(run.text));
  for (const pattern of expect.textMustNot ?? []) {
    add(`textMustNot /${pattern}/`, !new RegExp(pattern, "i").test(run.text));
  }
  return checks;
};

export const requestBody = (
  base: Base,
  state: SampleState,
  messages: ReadonlyArray<ApiMessage>,
) => ({
  model: MODEL,
  max_tokens: 16_000,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: state.effort },
  cache_control: { type: "ephemeral" },
  system: base.system,
  tools: state.tools,
  messages,
});

const callModel = Effect.fn("evaluateMcpToolUse.callModel")(function* (
  apiKey: string,
  body: unknown,
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
    }),
  );
  const response = yield* HttpClientRequest.post("https://api.anthropic.com/v1/messages").pipe(
    HttpClientRequest.setHeaders({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Claude Code sends this beta for `defer_loading` tools and `tool_reference` results.
      "anthropic-beta": "advanced-tool-use-2025-11-20",
    }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  if (response.status !== 200) {
    return yield* Effect.die(
      new Error(`Anthropic API ${response.status}: ${yield* response.text}`),
    );
  }
  return yield* HttpClientResponse.schemaBodyJson(ApiResponse)(response);
});

/** Runs one sample until the model ends its turn or uses up `maxSteps` calls. */
const runSample = Effect.fn("evaluateMcpToolUse.runSample")(function* (
  testCase: McpToolUseCase,
  config: {
    readonly apiKey: string;
    readonly effort: string;
    readonly maxSteps: number;
    readonly base: Base;
  },
) {
  const state = initialState(config.base, config.effort);
  const messages = buildMessages(testCase, config.base, state);
  const calls: Array<SampleRun["calls"][number]> = [];
  const said: Array<string> = [];
  const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let stopReason = "max_steps";
  for (let step = 0; step < config.maxSteps; step++) {
    const response = yield* callModel(config.apiKey, requestBody(config.base, state, messages));
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    messages.push({ role: "assistant", content: response.content });
    const uses = response.content.filter(isToolUse);
    said.push(...response.content.filter(isText).map((block) => block.text));
    calls.push(
      ...uses.map((use) => ({ step, tool: normalizeToolName(use.name), input: use.input })),
    );
    if (response.stop_reason !== "tool_use") {
      stopReason = response.stop_reason ?? "unknown";
      break;
    }
    const answers = uses.map((use) => answerToolCall(use, testCase, config.base, state));
    const notes = new Set(answers.flatMap((answer) => answer.note ?? []));
    messages.push({
      role: "user",
      content: [...answers.map((a) => a.result), ...[...notes].map(text)],
    });
  }
  const run: SampleRun = { calls, text: said.join("\n\n"), stopReason };
  return { ...run, usage };
});

interface ResultRow {
  readonly id: string;
  readonly kind: string;
  readonly pattern: string;
  readonly role: string;
  readonly pass: boolean;
  readonly checks: ReturnType<typeof gradeSample>;
  readonly usage: Usage;
  readonly error?: string;
}

const passRate = (rows: ReadonlyArray<{ readonly pass: boolean }>) =>
  rows.filter((row) => row.pass).length / rows.length;
const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const groups = <A>(rows: ReadonlyArray<A>, key: (row: A) => string) =>
  [...Map.groupBy(rows, key)].toSorted(([left], [right]) => left.localeCompare(right));

/** Markdown report. With a baseline, each case shows its earlier pass rate and the change. */
const summarize = (
  rows: ReadonlyArray<ResultRow>,
  baseline: ReadonlyMap<string, number> | undefined,
  header: string,
) => {
  const total = (key: keyof Usage) => rows.reduce((sum, row) => sum + row.usage[key], 0);
  const keys = ["input", "output", "cacheWrite", "cacheRead"] as const;
  const cost = keys.reduce((sum, key) => sum + total(key) * PRICE[key], 0) / 1e6;
  const table = (title: string, key: (row: ResultRow) => string, compare = false) => [
    `## ${title}`,
    "",
    compare ? "| Group | Pass | Baseline | Delta |" : "| Group | Pass |",
    compare ? "| --- | --- | --- | --- |" : "| --- | --- |",
    ...groups(rows, key).map(([group, members]) => {
      const now = passRate(members);
      const before = baseline?.get(group);
      const delta =
        before === undefined
          ? "new | |"
          : `${percent(before)} | ${Math.round((now - before) * 100)} pts |`;
      return `| ${group} | ${percent(now)} of ${members.length} |${compare ? ` ${delta}` : ""}`;
    }),
    "",
  ];
  const roles = new Set(rows.map((row) => row.role));
  const errors = rows.filter((row) => row.error !== undefined).length;
  return [
    "# MCP tool-use eval",
    "",
    `- ${header}`,
    `- Pass: ${percent(passRate(rows))} of ${rows.length} samples`,
    ...(errors === 0
      ? []
      : [`- ${errors} samples failed to run and count as failures. See results.jsonl.`]),
    `- Tokens: ${keys.map((key) => `${key} ${total(key)}`).join(", ")}. Estimated cost $${cost.toFixed(2)}.`,
    ...(roles.has("native-subagent")
      ? [
          "- native-subagent cases are approximate: Claude Code gives Agent subagents their own system prompt, which this runner does not rebuild.",
        ]
      : []),
    ...(roles.has("delegated-child")
      ? [
          "- delegated-child cases get the top-level system text, as T3 sends a child the same Claude append with only the task text as its prompt.",
        ]
      : []),
    "",
    ...table("Cases", (row) => row.id, baseline !== undefined),
    ...table("By kind", (row) => row.kind),
    ...table("By pattern", (row) => row.pattern),
  ].join("\n");
};

const PositiveInt = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
const Flags = Schema.Struct({
  template: Schema.String,
  cases: Schema.optional(Schema.Array(Schema.String)),
  out: Schema.optional(Schema.String),
  baseline: Schema.optional(Schema.String),
  case: Schema.optional(Schema.String),
  kind: Schema.optional(McpToolUseCase.fields.kind),
  samples: PositiveInt,
  concurrency: PositiveInt,
  "max-steps": PositiveInt,
  effort: Schema.Literals(EFFORTS),
  "t3-tools": Schema.Literals(["deferred", "inline"]),
  "user-instructions": Schema.Literals(["keep", "drop"]),
  "dry-run": Schema.Boolean,
});
const decodeFlags = Schema.decodeUnknownEffect(Flags);
const decodeTemplate = Schema.decodeUnknownEffect(Schema.fromJsonString(Template));
const decodeCase = Schema.decodeUnknownEffect(Schema.fromJsonString(McpToolUseCase));
const decodeBaselineRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, pass: Schema.Boolean })),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodePrettyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const string = { type: "string" } as const;

const main = Effect.gen(function* () {
  const { values } = NodeUtil.parseArgs({
    options: {
      template: string,
      cases: { ...string, multiple: true },
      out: string,
      baseline: string,
      case: string,
      kind: string,
      samples: { ...string, default: "3" },
      concurrency: { ...string, default: "4" },
      "max-steps": { ...string, default: "8" },
      effort: { ...string, default: "high" },
      "t3-tools": { ...string, default: "deferred" },
      "user-instructions": { ...string, default: "keep" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const flags = yield* decodeFlags(values);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readJsonl = <A, E>(file: string, decode: (line: string) => Effect.Effect<A, E>) =>
    fs.readFileString(file).pipe(
      Effect.flatMap((content) =>
        Effect.forEach(
          content.split("\n").filter((line) => line.trim() !== ""),
          (line) => decode(line),
        ),
      ),
    );
  const allCases =
    flags.cases === undefined
      ? mcpToolUseEvaluationCases
      : (yield* Effect.forEach(flags.cases, (file) => readJsonl(file, decodeCase))).flat();
  const ids = allCases.map((testCase) => testCase.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined)
    return yield* Effect.die(new Error(`Duplicate case id ${duplicate}.`));
  const selected = allCases.filter(
    (testCase) =>
      (flags.case === undefined || testCase.id === flags.case) &&
      (flags.kind === undefined || testCase.kind === flags.kind),
  );
  const [firstCase] = selected;
  if (firstCase === undefined) return yield* Effect.die(new Error("No cases match the filters."));
  const template = yield* fs.readFileString(flags.template).pipe(Effect.flatMap(decodeTemplate));
  const base = buildBase(
    "request" in template ? template.request.provider_native : template,
    {
      deferT3: flags["t3-tools"] === "deferred",
      keepUserInstructions: flags["user-instructions"] === "keep",
    },
    t3SystemAppend(),
  );
  if (flags["dry-run"]) {
    const state = initialState(base, flags.effort);
    const body = yield* encodePrettyJson(
      requestBody(base, state, buildMessages(firstCase, base, state)),
    );
    return yield* Effect.sync(() => process.stdout.write(`${body}\n`));
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const message =
      "Set ANTHROPIC_API_KEY. This runner never uses ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL.";
    return yield* Effect.die(new Error(message));
  }
  const out = flags.out;
  if (out === undefined) return yield* Effect.die(new Error("Use --out <directory>."));
  const config = { apiKey, effort: flags.effort, maxSteps: flags["max-steps"], base };
  const jobs = selected.flatMap((testCase) =>
    Array.from({ length: flags.samples }, () => testCase),
  );
  const rows = yield* Effect.forEach(
    jobs,
    (testCase) => {
      const { id, kind, pattern } = testCase;
      const identity = { id, kind, pattern, role: testCase.setup.role };
      return runSample(testCase, config).pipe(
        Effect.matchCause({
          onFailure: (cause): ResultRow => ({
            ...identity,
            pass: false,
            checks: [],
            usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
            error: Cause.pretty(cause),
          }),
          onSuccess: (sample): ResultRow => {
            const checks = gradeSample(testCase.expect, sample);
            return { ...identity, pass: checks.every((check) => check.pass), checks, ...sample };
          },
        }),
        Effect.tap((row) => Effect.log(`${row.id}: ${row.pass ? "pass" : "FAIL"}`)),
      );
    },
    { concurrency: flags.concurrency },
  );
  const previous =
    flags.baseline === undefined ? undefined : yield* readJsonl(flags.baseline, decodeBaselineRow);
  const baseline =
    previous &&
    new Map(groups(previous, (row) => row.id).map(([id, members]) => [id, passRate(members)]));
  const commit = NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
    encoding: "utf8",
  }).trim();
  const summary = summarize(
    rows,
    baseline,
    `Commit \`${commit}\`, ${MODEL} at ${flags.effort} effort, T3 tools ${flags["t3-tools"]}, user instructions ${flags["user-instructions"]}, ${flags.samples} samples per case, template \`${path.basename(flags.template)}\``,
  );
  const lines = yield* Effect.forEach(rows, (row) => encodeJson(row));
  yield* fs.makeDirectory(out, { recursive: true });
  yield* fs.writeFileString(
    path.join(out, "results.jsonl"),
    lines.map((line) => `${line}\n`).join(""),
  );
  yield* fs.writeFileString(path.join(out, "summary.md"), summary);
  yield* Effect.log(`Wrote ${rows.length} samples to ${out}.\n\n${summary}`);
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
