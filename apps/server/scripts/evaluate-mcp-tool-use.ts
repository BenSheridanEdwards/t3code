#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Replays small fake threads against Claude Sonnet 5.5 to check how agents use T3 Code's MCP
 * tools. A captured Claude Code request supplies the system prompt, reminders, and native tools.
 * T3's instructions, tool schemas, and delegated task prompt come from this checkout, so running
 * two branches A/B tests an instruction rewrite.
 *
 *   node scripts/evaluate-mcp-tool-use.ts --template <capture.json> --out <dir> [--cases <file.jsonl>]...
 *   node scripts/evaluate-mcp-tool-use.ts --template <capture.json> --dry-run [--case <id>[,<id>]]
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

import { taskPrompt } from "../src/mcp/OrchestratorMcpService.ts";
import { AttachmentToolkit } from "../src/mcp/toolkits/attachment/tools.ts";
import { DeviceToolkit } from "../src/mcp/toolkits/device/tools.ts";
import { EnvironmentToolkit } from "../src/mcp/toolkits/environment/tools.ts";
import { HtmlToolkit } from "../src/mcp/toolkits/html/tools.ts";
import { OrchestratorToolkit } from "../src/mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../src/mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../src/mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../src/mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../src/mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../src/mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../src/mcp/toolkits/worktree/tools.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  type McpToolUseCall,
  McpToolUseCase,
  mcpToolUseEvaluationCases,
} from "./mcpToolUseEvaluationCases.ts";
import {
  gitStatusReminder,
  makeWorld,
  runFileTool,
  runShell,
  type World,
  webPage,
} from "./mcpToolUseWorld.ts";

const MODEL = "claude-sonnet-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// USD per million tokens. Cache writes use the 5-minute rate.
const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
const T3_PREFIX = "mcp__t3-code__";
const RUNTIME_MARKER = "<runtime_info>";
const TOOL_LOADED = "Tool loaded.";
const DEFERRED_LIST =
  /(The following deferred tools are now available via ToolSearch\.[^\n]*\n)((?:[^\n]+\n)*)/;
const MODEL_LINE = /You are powered by the model named .+?\. The exact model ID is [\w.-]+\./;

type Block = { readonly type: string; readonly [key: string]: unknown };
type ApiMessage = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };
type ApiTool = { readonly name: string; readonly [key: string]: unknown };
type Usage = Record<keyof typeof PRICE, number>;
type Call = { readonly step: number; readonly tool: string; readonly input: unknown };
export type SampleRun = { readonly calls: ReadonlyArray<Call>; text: string; stopReason: string };

const Rest = [Schema.Record(Schema.String, Schema.Unknown)];
const AnyBlock = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  Rest,
);
const Content = Schema.Union([Schema.String, Schema.Array(AnyBlock)]);
const MessagesRequest = Schema.Struct({
  system: Schema.optional(Content),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })),
  tools: Schema.Array(Schema.StructWithRest(Schema.Struct({ name: Schema.String }), Rest)),
});
// A CLIProxyAPI capture keeps the Anthropic body at request.provider_native.
const Capture = Schema.Struct({ request: Schema.Struct({ provider_native: MessagesRequest }) });
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
const Count = Schema.optional(Schema.NullOr(Schema.Number));
const ApiResponse = Schema.Struct({
  content: Schema.Array(AnyBlock),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_creation_input_tokens: Count,
    cache_read_input_tokens: Count,
  }),
});

const text = (value: string): Block => ({ type: "text", text: value });
const reminder = (value: string) => text(`<system-reminder>\n${value}\n</system-reminder>`);
const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
const toolResult = (id: string, content: unknown): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: valueText(content),
});
const texts = (content: typeof Content.Type) =>
  typeof content === "string" ? [content] : content.flatMap((block) => block.text ?? []);
const isT3Name = (name: string) => name.startsWith(T3_PREFIX) || name.startsWith("mcp__t3_code__");
const hasTool = (tools: ReadonlyArray<ApiTool>, name: string) =>
  tools.some((tool) => tool.name === name);

/** Grading name: T3 tools lose their MCP prefix, native tools keep the part after the last `_`. */
const normalizeToolName = (name: string) =>
  isT3Name(name) ? name.slice(T3_PREFIX.length) : name.slice(name.lastIndexOf("_") + 1);

// McpHttpServer advertises each tool's JSON schema, and Claude Code passes the MCP name,
// description, and schema through unchanged.
const t3Tools: ReadonlyArray<ApiTool> = [
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
    input_schema: Tool.getJsonSchema(tool),
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
  if (isRecord(systemPrompt) && systemPrompt.type === "preset" && systemPrompt.append) {
    return systemPrompt.append;
  }
  throw new Error("makeClaudeQueryOptions no longer appends T3 text to a preset prompt.");
};

const stringProperty = (description: string) => ({ type: "string", description });
const NATIVE_SCHEMAS: Readonly<Record<string, Omit<ApiTool, "name">>> = {
  WebFetch: {
    description: "Fetches content from a URL and answers the prompt about it.",
    input_schema: {
      type: "object",
      properties: {
        url: stringProperty("The URL to fetch"),
        prompt: stringProperty("What to extract"),
      },
      required: ["url", "prompt"],
    },
  },
  WebSearch: {
    description: "Searches the web and returns result titles, links, and snippets.",
    input_schema: {
      type: "object",
      properties: { query: stringProperty("The search query") },
      required: ["query"],
    },
  },
};

/** Rebuilds the parts of a captured request that every case shares. */
export const buildBase = (
  template: typeof MessagesRequest.Type,
  options: { readonly keepUserInstructions: boolean },
) => {
  const firstAssistant = template.messages.findIndex((message) => message.role === "assistant");
  const head = template.messages.slice(0, firstAssistant === -1 ? undefined : firstAssistant);
  const systemTexts = [
    template.system ?? [],
    ...head.flatMap((m) => (m.role === "system" ? [m.content] : [])),
  ]
    .flatMap(texts)
    .filter((value) => !value.startsWith("x-anthropic-billing-header:"));
  const deferredList = DEFERRED_LIST.exec(systemTexts.join("\n"))?.[2];
  if (systemTexts.filter((value) => value.includes(RUNTIME_MARKER)).length !== 1 || !deferredList) {
    throw new Error(`The template needs one ${RUNTIME_MARKER} block and a deferred tool list.`);
  }
  const nativeDeferred = deferredList.split("\n").filter((name) => name && !isT3Name(name));
  const names = [...nativeDeferred, ...t3Tools.map((tool) => tool.name)].toSorted().join("\n");
  const append = t3SystemAppend();
  const sonnet = `You are powered by the model named Sonnet 5.5. The exact model ID is ${MODEL}.`;
  const system = systemTexts.map((value) => {
    // T3's append is the tail of its block: runtime info, PR linking, then orchestration.
    const at = value.indexOf(RUNTIME_MARKER);
    return (at === -1 ? value : value.slice(0, at) + append)
      .replace(DEFERRED_LIST, (_, header: string) => `${header}${names}\n`)
      .replace(MODEL_LINE, sonnet);
  });
  const [first] = template.messages;
  // The last block is the captured prompt.
  const reminders = (first?.role === "user" ? texts(first.content).slice(0, -1) : []).filter(
    (value) =>
      options.keepUserInstructions || !value.includes("Codebase and user instructions are"),
  );
  // gitStatus names a real repo state. Each case gets one built from its fake world instead.
  const gitStatusAt = reminders.findIndex((value) => value.includes("# gitStatus"));
  const joined = systemTexts.join("\n");
  // Claude Code sends no schema for tools it only names. Web tools get their usual one, the
  // rest load open.
  const open = { type: "object", additionalProperties: true };
  const nativeSchema = (name: string) =>
    NATIVE_SCHEMAS[name] ?? { description: name, input_schema: open };
  return {
    system: system.map(text),
    reminders: reminders.filter((_, i) => i !== gitStatusAt).map(text),
    gitStatusAt: gitStatusAt === -1 ? reminders.length : gitStatusAt,
    /** The fake world's cwd and OS follow the template's environment section. */
    environment: {
      cwd: /Primary working directory: (\S+)/.exec(joined)?.[1] ?? "/home/user/app",
      platform: /Platform: (\w+)/.exec(joined)?.[1] ?? "linux",
    },
    nativeTools: template.tools.filter((tool) => !isT3Name(tool.name)),
    /** Tools ToolSearch loads: T3 tools from source, and native tools the template only names. */
    deferred: [...t3Tools, ...nativeDeferred.map((name) => ({ name, ...nativeSchema(name) }))],
  };
};

type Base = ReturnType<typeof buildBase>;
/**
 * One sample's state. ToolSearch adds loaded schemas to `tools`, like Claude Code. `world` is the
 * sample's own copy of the fake repo; `linked` and `nextTask` keep T3 results consistent.
 */
type Sample = {
  readonly testCase: McpToolUseCase;
  readonly base: Base;
  readonly tools: Array<ApiTool>;
  readonly world: World;
  readonly linked: Set<string>;
  nextTask: number;
};

export const makeSample = (testCase: McpToolUseCase, base: Base): Sample => {
  const prior = testCase.setup.priorTurns ?? [];
  const priorCalls = prior.flatMap((turn) => turn.toolCalls ?? []);
  const urls = priorCalls.flatMap((call) =>
    ["link_pull_request", "watch_pull_request"].includes(call.tool) && isRecord(call.input)
      ? [valueText(call.input.url)]
      : [],
  );
  const taskNumbers = [...valueText(prior).matchAll(/task-(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  return {
    testCase,
    base,
    tools: [...base.nativeTools],
    world: makeWorld(testCase.setup.world, base.environment),
    linked: new Set(urls),
    nextTask: Math.max(0, ...taskNumbers) + 1,
  };
};

const findTool = (base: Base, bare: string) =>
  [...base.nativeTools, ...base.deferred].find((tool) => normalizeToolName(tool.name) === bare);

/** Adds deferred schemas to `tools` and returns the ToolSearch result Claude Code sends. */
const loadTools = (tools: Array<ApiTool>, id: string, found: ReadonlyArray<ApiTool>): Block => {
  for (const tool of found) {
    if (!hasTool(tools, tool.name)) tools.push({ ...tool, defer_loading: true });
  }
  const content = found.map((tool) => ({ type: "tool_reference", tool_name: tool.name }));
  return { type: "tool_result", tool_use_id: id, content };
};

/** Messages for a case: reminders, context, prior turns with real tool blocks, then the prompt. */
export const buildMessages = ({ testCase, base, tools, world }: Sample) => {
  const messages: Array<ApiMessage> = [];
  const push = (role: ApiMessage["role"], ...blocks: ReadonlyArray<Block>) => {
    const last = messages.at(-1);
    if (last?.role !== role) messages.push({ role, content: blocks });
    else messages[messages.length - 1] = { role, content: [...last.content, ...blocks] };
  };
  const { role, context, delegateRole, priorTurns = [] } = testCase.setup;
  const notes = [
    role === "native-subagent"
      ? "You are a subagent started by the parent agent's Agent tool. Your final message goes to the parent agent, not to the user."
      : undefined,
    context,
  ];
  const gitStatus = gitStatusReminder(world, valueText(testCase.setup.priorTurns ?? []));
  const reminders = base.reminders.toSpliced(base.gitStatusAt, 0, text(gitStatus));
  push("user", ...reminders, ...notes.flatMap((note) => (note ? [reminder(note)] : [])));
  const toolSearch = findTool(base, "ToolSearch")?.name ?? "ToolSearch";
  let nextId = 0;
  for (const turn of priorTurns) {
    const calls = (turn.toolCalls ?? []).map((call) => {
      const tool = findTool(base, call.tool);
      if (tool === undefined) throw new Error(`${testCase.id}: unknown prior tool ${call.tool}.`);
      return { ...call, id: `toolu_prior_${nextId++}`, name: tool.name, tool };
    });
    // Prior T3 calls load their schemas first, as in a real deferred session.
    const unloaded = [...new Set(calls.map((call) => call.tool))].filter(
      (tool) => !hasTool(tools, tool.name),
    );
    if (unloaded.length > 0) {
      const id = `toolu_prior_${nextId++}`;
      const query = `select:${unloaded.map((tool) => tool.name).join(",")}`;
      const input = { query, max_results: unloaded.length };
      push("assistant", { type: "tool_use", id, name: toolSearch, input });
      push("user", loadTools(tools, id, unloaded), text(TOOL_LOADED));
    }
    // One call per step, as most real turns run them.
    for (const { id, name, input, result } of calls) {
      push("assistant", { type: "tool_use", id, name, input });
      push("user", toolResult(id, result));
    }
    if (turn.text) push(turn.role, text(turn.text));
  }
  const { prompt } = testCase;
  const childPrompt = () => taskPrompt({ task: prompt, role: delegateRole });
  push("user", text(role === "delegated-child" ? childPrompt() : prompt));
  return messages;
};

// Results for T3 tools a case does not mock. The model ids are public in this repo's catalog.
const claudeModel = (id: string) => ({ id, options: [{ id: "effort", values: EFFORTS }] });
const codexModel = (id: string) => ({ id, options: [{ id: "reasoningEffort", values: EFFORTS }] });
const DEFAULT_CAPABILITIES = {
  inheritedProviderInstanceId: "claudeAgent",
  inheritedModel: MODEL,
  providers: [
    { providerInstanceId: "claudeAgent", models: ["claude-opus-5-5", MODEL].map(claudeModel) },
    { providerInstanceId: "codex", models: ["gpt-6-astra", "gpt-6.1-sol"].map(codexModel) },
  ],
};
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEFAULT_THREAD = {
  title: "Fix the flaky reconnect test",
  status: "idle",
  items: [
    {
      position: 1,
      createdBy: "user",
      text: "The reconnect test in src/session.test.ts fails about 1 in 10 runs. Fix it.",
    },
    {
      position: 2,
      createdBy: "assistant",
      text: "Fixed. The test now waits for the socket close event before it reconnects. 20 runs in a row pass.",
    },
  ],
};
const HTML_RENDERED =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

/** Pull request identity from a `url` or `repository` plus `number` input, like T3's results. */
const pullRequest = (world: World, input: Readonly<Record<string, unknown>>) => {
  const url = typeof input.url === "string" ? input.url : "";
  const repository =
    /github\.com\/([^/]+\/[^/]+)\/pull/.exec(url)?.[1] ?? valueText(input.repository ?? world.repo);
  const number = Number(/(\d+)\/?$/.exec(url)?.[1] ?? input.number);
  return {
    host: "github.com",
    repository,
    number,
    url: url || `https://github.com/${repository}/pull/${number}`,
  };
};

/** A believable T3 result for a tool the case does not mock. */
const t3Default = (sample: Sample, name: string, input: Readonly<Record<string, unknown>>) => {
  const pr = () => pullRequest(sample.world, input);
  switch (name) {
    case "orchestrator_capabilities":
      return DEFAULT_CAPABILITIES;
    case "delegate_task": {
      const n = sample.nextTask++;
      const target = isRecord(input.target) ? input.target : {};
      return {
        taskId: `task-${n}`,
        childThreadId: uuid(n),
        childRunId: `run-${n}`,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        providerInstanceId:
          target.providerInstanceId ?? DEFAULT_CAPABILITIES.inheritedProviderInstanceId,
        model: target.model ?? DEFAULT_CAPABILITIES.inheritedModel,
        summary: null,
        hasPendingQuestion: false,
        pendingApproval: null,
      };
    }
    case "task_status":
      return {
        taskId: input.taskId,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        summary: null,
      };
    case "task_cancel":
      return { taskId: input.taskId, status: "cancel_requested" };
    case "link_pull_request": {
      const alreadyLinked = sample.linked.has(pr().url);
      sample.linked.add(pr().url);
      return { ...pr(), alreadyLinked };
    }
    case "unlink_pull_request":
      return { ...pr(), wasLinked: sample.linked.delete(pr().url) };
    case "watch_pull_request":
      sample.linked.add(pr().url);
      return { ...pr(), watching: true, wasWatching: false };
    case "unwatch_pull_request":
      return { ...pr(), watching: false, wasWatching: true };
    case "list_thread_pull_requests":
      return {
        pullRequests: [...sample.linked].map((url) => ({
          ...pullRequest(sample.world, { url }),
          source: "agent",
          watching: false,
          state: "open",
        })),
        chains: [],
      };
    case "t3_thread_read": {
      const threadId = valueText(input.threadId);
      const { title, status, items } = DEFAULT_THREAD;
      const link = `[${title}](t3-thread://v1/${PROJECT_ID}/${threadId})`;
      return { thread: { threadId, title, link, status }, items, nextPosition: 3, hasMore: false };
    }
    case "html_preview":
      return { width: 728, contentHeight: 560, capturedHeight: 560, consoleMessages: [] };
    case "html_render":
      return {
        htmlRender: { attachmentId: "att-1", title: input.title ?? "Visual", height: 560 },
        message: HTML_RENDERED,
      };
    case "preview_status":
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      };
    default:
      return { ok: true };
  }
};

/** ToolSearch: `select:a,b` loads those tools. Other queries load tools whose name has a word. */
const searchTools = (base: Base, query: string, max: number) => {
  if (query.startsWith("select:")) {
    const wanted = query.slice("select:".length).split(",");
    return base.deferred.filter((tool) =>
      wanted.some((name) => [tool.name, normalizeToolName(tool.name)].includes(name.trim())),
    );
  }
  const words = query
    .toLowerCase()
    .split(/[\s+]+/)
    .filter(Boolean);
  const hits = (tool: ApiTool) => words.filter((word) => tool.name.toLowerCase().includes(word));
  const found = base.deferred.filter((tool) => hits(tool).length > 0);
  return found.toSorted((a, b) => hits(b).length - hits(a).length).slice(0, max);
};

const SUBAGENT_WATCH_ERROR =
  "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";

/** Result for a native tool the case does not mock. Shell and file tools use the fake world. */
const nativeResult = (sample: Sample, name: string, input: Readonly<Record<string, unknown>>) => {
  const shellMocks = sample.testCase.setup.shellMocks ?? [];
  if (name === "Bash") return runShell(sample.world, shellMocks, valueText(input.command));
  const file = runFileTool(sample.world, name, input);
  if (file !== undefined) return file;
  if (name === "WebFetch")
    return { text: webPage(sample.world, valueText(input.url)), error: false };
  const skill = valueText(input.skill);
  const results: Readonly<Record<string, string>> = {
    Agent: "The agent finished. Summary: the task is done and nothing else needs attention.",
    Skill: `Launching skill: ${skill}\n\nBase directory for this skill: ~/.claude/skills/${skill}\n\nThis skill adds no steps for this task. Do it with your usual tools.`,
    WebSearch: "No results found.",
  };
  return { text: results[name] ?? "OK", error: false };
};

/** Canned result for one tool call. */
const answerToolCall = (sample: Sample, call: typeof ToolUse.Type) => {
  const { testCase, base, tools } = sample;
  const name = normalizeToolName(call.name);
  const input = isRecord(call.input) ? call.input : {};
  const failed = (error: string): Block => ({ ...toolResult(call.id, error), is_error: true });
  if (!hasTool(tools, call.name)) {
    const error = `InputValidationError: ${call.name} is deferred. Load it with ToolSearch first.`;
    return failed(`<tool_use_error>${error}</tool_use_error>`);
  }
  if (name === "ToolSearch") {
    const max = typeof input.max_results === "number" ? input.max_results : 5;
    const found = searchTools(base, valueText(input.query), max);
    if (found.length === 0) return toolResult(call.id, "No matching deferred tools found");
    return loadTools(tools, call.id, found);
  }
  const mock = testCase.setup.mocks?.[name];
  if (mock !== undefined && mock !== "default") return toolResult(call.id, mock);
  if (isT3Name(call.name)) {
    // T3 refuses a watch from a delegated child.
    if (name === "watch_pull_request" && testCase.setup.role === "delegated-child") {
      return failed(SUBAGENT_WATCH_ERROR);
    }
    return toolResult(call.id, t3Default(sample, name, input));
  }
  const { text: output, error } = nativeResult(sample, name, input);
  return error ? failed(output) : toolResult(call.id, output);
};

const BOUND = /^([<>]=)(-?\d+(?:\.\d+)?)$/;
/** Partial match: `~text` is a case-insensitive substring, `<=N` / `>=N` bound a number. */
const matches = (expected: unknown, actual: unknown): boolean => {
  const bound = typeof expected === "string" ? BOUND.exec(expected) : null;
  if (bound !== null) {
    const limit = Number(bound[2]);
    return typeof actual === "number" && (bound[1] === "<=" ? actual <= limit : actual >= limit);
  }
  if (typeof expected === "string" && expected.startsWith("~")) {
    return valueText(actual).toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && expected.every((item) => actual.some((at) => matches(item, at)))
    );
  }
  if (!isRecord(expected)) return expected === actual;
  const at = (path: string) =>
    path
      .split(".")
      .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), actual);
  return Object.entries(expected).every(([path, value]) => matches(value, at(path)));
};

/** delegate_task takes `target.options` as an object or `[{id, value}]`. Grade both as an object. */
const withOptionsObject = (input: unknown) => {
  if (!isRecord(input) || !isRecord(input.target) || !Array.isArray(input.target.options)) {
    return input;
  }
  const options = Object.fromEntries(
    input.target.options.flatMap((option) =>
      isRecord(option) ? [[valueText(option.id), option.value]] : [],
    ),
  );
  return { ...input, target: { ...input.target, options } };
};

export const gradeSample = (expect: McpToolUseCase["expect"], run: SampleRun) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const calls = run.calls.map((call) => ({ ...call, input: withOptionsObject(call.input) }));
  const count = (tool: string) => calls.filter((call) => call.tool === tool).length;
  const found = ({ tool, args = {} }: McpToolUseCall) =>
    calls.some((call) => call.tool === tool && matches(args, call.input));
  const label = ({ tool, args }: McpToolUseCall) => (args ? `${tool} ${valueText(args)}` : tool);
  for (const call of expect.calls ?? []) add(`calls ${label(call)}`, found(call));
  for (const call of expect.callsMustNot ?? []) add(`callsMustNot ${label(call)}`, !found(call));
  for (const tool of expect.notCalls ?? []) add(`notCalls ${tool}`, count(tool) === 0);
  if (expect.order !== undefined) {
    const firsts = expect.order.map((tool) => calls.findIndex((call) => call.tool === tool));
    const inOrder = firsts.every((at, i) => at > (firsts[i - 1] ?? -1));
    add(`order ${expect.order.join(" > ")}`, inOrder);
  }
  for (const [t, n] of Object.entries(expect.minCalls ?? {}))
    add(`minCalls ${t} >= ${n}`, count(t) >= n);
  for (const [t, n] of Object.entries(expect.maxCalls ?? {}))
    add(`maxCalls ${t} <= ${n}`, count(t) <= n);
  if (expect.endsTurnAfter !== undefined) {
    const lastStep = Math.max(-1, ...calls.map((call) => call.step));
    const last = calls.filter((call) => call.step === lastStep).map((call) => call.tool);
    const ended = run.stopReason === "end_turn" && last.includes(expect.endsTurnAfter);
    add(`endsTurnAfter ${expect.endsTurnAfter}`, ended);
  }
  // Bash and Monitor both take a shell `command`.
  const shell = calls.flatMap((call) =>
    isRecord(call.input) && typeof call.input.command === "string" ? [call.input.command] : [],
  );
  const test = (pattern: string, value: string) => new RegExp(pattern).test(value);
  for (const p of expect.shellMustNot ?? [])
    add(`shellMustNot /${p}/`, !shell.some((c) => test(p, c)));
  for (const p of expect.textMust ?? []) add(`textMust /${p}/`, test(p, run.text));
  for (const p of expect.textMustNot ?? []) add(`textMustNot /${p}/`, !test(p, run.text));
  return checks;
};

const requestBody = ({ base, tools }: Sample, effort: string, messages: unknown) => ({
  model: MODEL,
  max_tokens: 16_000,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort },
  cache_control: { type: "ephemeral" },
  // Like Claude Code, cache the shared system prompt so every sample reuses it.
  system: base.system.map((block, i) =>
    i === base.system.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block,
  ),
  tools,
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
    const body = yield* response.text;
    return yield* Effect.die(new Error(`Anthropic API ${response.status}: ${body}`));
  }
  return yield* HttpClientResponse.schemaBodyJson(ApiResponse)(response);
});

/** Runs one sample until the model ends its turn or uses up `maxSteps` calls. */
const runSample = Effect.fn("evaluateMcpToolUse.runSample")(function* (
  testCase: McpToolUseCase,
  config: { readonly apiKey: string; readonly effort: string; readonly maxSteps: number },
  base: Base,
) {
  const sample = makeSample(testCase, base);
  const messages = buildMessages(sample);
  const start = messages.length;
  const calls: Array<Call> = [];
  const said: Array<string> = [];
  const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let stopReason = "max_steps";
  for (let step = 0; step < config.maxSteps; step++) {
    const response = yield* callModel(config.apiKey, requestBody(sample, config.effort, messages));
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    messages.push({ role: "assistant", content: response.content });
    said.push(...response.content.filter(isText).map((block) => block.text));
    const uses = response.content.filter(isToolUse);
    calls.push(
      ...uses.map((use) => ({ step, tool: normalizeToolName(use.name), input: use.input })),
    );
    if (response.stop_reason !== "tool_use") {
      stopReason = response.stop_reason ?? "unknown";
      break;
    }
    const results = uses.map((use) => answerToolCall(sample, use));
    // Claude Code adds this text after a ToolSearch that loaded tools.
    const loaded = results.some((result) => Array.isArray(result.content));
    messages.push({ role: "user", content: [...results, ...(loaded ? [text(TOOL_LOADED)] : [])] });
  }
  // The transcript (model turns and tool results) shows what the agent saw when a case fails.
  return { calls, text: said.join("\n\n"), stopReason, usage, transcript: messages.slice(start) };
});

type ResultRow = Pick<McpToolUseCase, "id" | "kind" | "pattern"> & {
  readonly role: string;
  readonly pass: boolean;
  readonly usage: Usage;
};

const passRate = (rows: ReadonlyArray<{ readonly pass: boolean }>) =>
  rows.filter((row) => row.pass).length / rows.length;
const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const groups = <A>(rows: ReadonlyArray<A>, key: (row: A) => string) =>
  [...Map.groupBy(rows, key)].toSorted(([left], [right]) => left.localeCompare(right));

/** Markdown report. With a baseline, each case shows its earlier pass rate and the change. */
const summarize = (rows: Array<ResultRow>, header: string, before?: Map<string, number>) => {
  const keys = ["input", "output", "cacheWrite", "cacheRead"] as const;
  const total = (key: keyof Usage) => rows.reduce((sum, row) => sum + row.usage[key], 0);
  const cost = keys.reduce((sum, key) => sum + total(key) * PRICE[key], 0) / 1e6;
  const table = (title: string, key: (row: ResultRow) => string, compare = false) => [
    `## ${title}\n`,
    compare ? "| Group | Pass | Baseline | Delta |" : "| Group | Pass |",
    compare ? "| --- | --- | --- | --- |" : "| --- | --- |",
    ...groups(rows, key).map(([group, members]) => {
      const now = passRate(members);
      const was = before?.get(group);
      const delta =
        was === undefined ? "new | |" : `${percent(was)} | ${Math.round((now - was) * 100)} pts |`;
      return `| ${group} | ${percent(now)} of ${members.length} |${compare ? ` ${delta}` : ""}`;
    }),
    "",
  ];
  const nativeNote =
    "- native-subagent cases are approximate: Claude Code gives Agent subagents their own system prompt, which this runner does not rebuild.";
  return [
    "# MCP tool-use eval\n",
    `- ${header}`,
    `- Pass: ${percent(passRate(rows))} of ${rows.length} samples. Samples that failed to run count as failures.`,
    `- Tokens: ${keys.map((key) => `${key} ${total(key)}`).join(", ")}. Estimated cost $${cost.toFixed(2)}.`,
    ...(rows.some((row) => row.role === "native-subagent") ? [nativeNote] : []),
    "",
    ...table("Cases", (row) => row.id, before !== undefined),
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
  case: Schema.optional(Schema.Array(Schema.String)),
  samples: PositiveInt,
  concurrency: PositiveInt,
  "max-steps": PositiveInt,
  effort: Schema.Literals(EFFORTS),
  "user-instructions": Schema.Literals(["keep", "drop"]),
  "dry-run": Schema.Boolean,
});
const decodeFlags = Schema.decodeUnknownEffect(Flags);
const decodeCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(Capture));
const decodeCase = Schema.decodeUnknownEffect(Schema.fromJsonString(McpToolUseCase));
const decodeBaselineRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, pass: Schema.Boolean })),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const string = { type: "string" } as const;

const main = Effect.gen(function* () {
  const { values } = NodeUtil.parseArgs({
    options: {
      template: string,
      cases: { ...string, multiple: true },
      out: string,
      baseline: string,
      case: { ...string, multiple: true },
      samples: { ...string, default: "3" },
      concurrency: { ...string, default: "4" },
      "max-steps": { ...string, default: "10" },
      effort: { ...string, default: "high" },
      // T3's text must work for every user, so the captured CLAUDE.md is dropped by default.
      "user-instructions": { ...string, default: "drop" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const flags = yield* decodeFlags(values);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readJsonl = <A, E>(file: string, decode: (line: string) => Effect.Effect<A, E>) =>
    fs.readFileString(file).pipe(
      Effect.map((content) => content.split("\n").filter((line) => line.trim() !== "")),
      Effect.flatMap((lines) => Effect.forEach(lines, (line) => decode(line))),
    );
  const cases =
    flags.cases === undefined
      ? mcpToolUseEvaluationCases
      : (yield* Effect.forEach(flags.cases, (file) => readJsonl(file, decodeCase))).flat();
  const wanted = flags.case?.flatMap((ids) => ids.split(","));
  const selected = cases.filter(({ id }) => wanted === undefined || wanted.includes(id));
  if (selected.length === 0) return yield* Effect.die(new Error("No case matches --case."));
  const capture = yield* fs.readFileString(flags.template).pipe(Effect.flatMap(decodeCapture));
  const keepUserInstructions = flags["user-instructions"] === "keep";
  const base = buildBase(capture.request.provider_native, { keepUserInstructions });
  if (flags["dry-run"]) {
    // One JSON line per case. Without --case this also checks that every case builds.
    for (const testCase of selected) {
      const sample = makeSample(testCase, base);
      const body = requestBody(sample, flags.effort, buildMessages(sample));
      process.stdout.write(`${yield* encodeJson(body)}\n`);
    }
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const out = flags.out;
  if (!apiKey || out === undefined) {
    const message =
      "Set ANTHROPIC_API_KEY and pass --out <directory>. ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are never used.";
    return yield* Effect.die(new Error(message));
  }
  const config = { apiKey, effort: flags.effort, maxSteps: flags["max-steps"] };
  const jobs = selected.flatMap((testCase) =>
    Array.from({ length: flags.samples }, () => testCase),
  );
  const rows = yield* Effect.forEach(
    jobs,
    (testCase) => {
      const { id, kind, pattern } = testCase;
      const identity = { id, kind, pattern, role: testCase.setup.role };
      const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      return runSample(testCase, config, base).pipe(
        Effect.matchCause({
          onFailure: (cause) => ({ ...identity, pass: false, usage, error: Cause.pretty(cause) }),
          onSuccess: (sample) => {
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
    flags.baseline === undefined ? [] : yield* readJsonl(flags.baseline, decodeBaselineRow);
  const baseline = new Map(groups(previous, (row) => row.id).map(([id, r]) => [id, passRate(r)]));
  const commit = NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
    encoding: "utf8",
  }).trim();
  const header = `Commit \`${commit}\`, ${MODEL} at ${flags.effort} effort, user instructions ${flags["user-instructions"]}, ${flags.samples} samples per case, template \`${path.basename(flags.template)}\``;
  const summary = summarize(rows, header, flags.baseline === undefined ? undefined : baseline);
  yield* fs.makeDirectory(out, { recursive: true });
  const lines = yield* Effect.forEach(rows, (row) => encodeJson(row));
  yield* fs.writeFileString(path.join(out, "results.jsonl"), `${lines.join("\n")}\n`);
  yield* fs.writeFileString(path.join(out, "summary.md"), summary);
  yield* Effect.log(`Wrote ${rows.length} samples to ${out}.\n\n${summary}`);
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
