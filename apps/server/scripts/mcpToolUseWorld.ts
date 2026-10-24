/**
 * A small fake repo for the MCP tool-use eval. Shell commands and file tools read and change a
 * per-sample copy of it, so agents get believable output while nothing runs on the host. It covers
 * the commands agents use to orient themselves and ship a PR, not a shell: unknown commands print
 * nothing and succeed.
 */
import * as Schema from "effect/Schema";

const Commit = Schema.Struct({
  sha: Schema.String,
  subject: Schema.String,
  body: Schema.optional(Schema.String),
});
/** `state` is pass, fail, or pending. */
const Check = Schema.Struct({ name: Schema.String, state: Schema.String });
/** Keys besides these (body, mergeStateStatus, ...) pass through to `gh pr view --json`. */
const PullRequest = Schema.StructWithRest(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    headRefName: Schema.optional(Schema.String),
    state: Schema.optional(Schema.String),
    checks: Schema.optional(Schema.Array(Check)),
    /** What `gh pr diff` prints for this PR. Defaults to the world's diff. */
    diff: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export const McpToolUseWorld = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  /** GitHub `owner/name`. */
  repo: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  /** Other local branches and the commit each points at. */
  branches: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Newest first. On a branch other than main, these are the commits main lacks. */
  commits: Schema.optional(Schema.Array(Commit)),
  /** `git status --short` lines. */
  status: Schema.optional(Schema.String),
  /** What `git diff <range>` and `git show` print. Files it adds or changes exist in the repo. */
  diff: Schema.optional(Schema.String),
  /** File contents by path, relative to `cwd` or absolute. */
  files: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  prs: Schema.optional(Schema.Array(PullRequest)),
  /** Web pages by URL prefix, for curl and WebFetch. Other URLs get an empty page. */
  pages: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type McpToolUseWorldSpec = typeof McpToolUseWorld.Type;

type Pr = typeof PullRequest.Type & { state: string };
export type World = {
  readonly cwd: string;
  /** The shell's directory. `cd` changes it for the rest of one command. */
  dir: string;
  readonly repo: string;
  readonly platform: string;
  branch: string;
  readonly branches: Record<string, string>;
  readonly commits: Array<typeof Commit.Type>;
  /** How many of `commits` main lacks. */
  ahead: number;
  status: string;
  readonly diff: string;
  /** Keyed by absolute path. */
  readonly files: Map<string, string>;
  readonly prs: Array<Pr>;
  readonly pages: Record<string, string>;
  /** Branch tips on origin, besides main. A PR's `headRefOid` sets its branch's tip. */
  readonly remote: Map<string, string>;
};

const MAIN_COMMITS = [
  { sha: "9f2c1ab", subject: "feat(web): show the model name in the thread header" },
  { sha: "4e7d2c0", subject: "fix(server): retry provider start once on ENOENT" },
  { sha: "b81f3d9", subject: "chore: update dependencies" },
];
const DEFAULT_FILES = {
  "package.json": `{\n  "name": "app",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build",\n    "test": "vitest run",\n    "lint": "eslint .",\n    "typecheck": "tsc --noEmit"\n  },\n  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" },\n  "devDependencies": { "eslint": "^9.30.0", "typescript": "^5.9.0", "vite": "^7.1.0", "vitest": "^4.0.0" }\n}\n`,
  "README.md": "# app\n\nA web app with a small Node server.\n",
  "tsconfig.json": `{\n  "compilerOptions": { "strict": true, "module": "esnext", "jsx": "react-jsx", "noEmit": true },\n  "include": ["**/*.ts", "**/*.tsx"]\n}\n`,
  "node_modules/react/package.json": `{ "name": "react", "version": "19.2.0" }\n`,
  "node_modules/vite/package.json": `{ "name": "vite", "version": "7.1.0" }\n`,
};

const normalize = (path: string) =>
  `/${path
    .split("/")
    .reduce<Array<string>>(
      (parts, part) =>
        part === ".." ? parts.slice(0, -1) : part === "" || part === "." ? parts : [...parts, part],
      [],
    )
    .join("/")}`;
const home = (w: World) => /^\/(?:home|Users)\/[^/]+/.exec(w.cwd)?.[0] ?? "/root";
const resolvePath = (w: World, path: string) =>
  normalize(
    path.startsWith("~")
      ? home(w) + path.slice(1)
      : path.startsWith("/")
        ? path
        : `${w.dir}/${path}`,
  );
const relative = (w: World, path: string) =>
  path.startsWith(`${w.cwd}/`) ? path.slice(w.cwd.length + 1) : path;

/** Per file in a unified diff: its path, the lines it ends with, and its +/- counts. */
const diffFiles = (diff: string) =>
  diff
    .split(/^diff --git a\/\S+ b\//m)
    .slice(1)
    .map((block) => {
      const [path = "", ...lines] = block.split("\n");
      const hunks = lines.slice(lines.findIndex((l) => l.startsWith("@@")) + 1);
      const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
      const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
      const side = (drop: string) =>
        hunks
          .filter((l) => l !== "" && !l.startsWith(drop) && !l.startsWith("@@"))
          .map((l) => l.slice(1))
          .join("\n");
      return { path, added, removed, before: side("+"), after: side("-") };
    });

/** A fresh world for one sample. `cwd` and `platform` come from the template's environment. */
export const makeWorld = (
  spec: McpToolUseWorldSpec | undefined,
  defaults: { readonly cwd: string; readonly platform: string },
): World => {
  const branch = spec?.branch ?? "main";
  const own = spec?.commits ?? [];
  const cwd = spec?.cwd ?? defaults.cwd;
  const w: World = {
    cwd,
    dir: cwd,
    repo: spec?.repo ?? "acme/app",
    platform: defaults.platform,
    branch,
    branches: { ...spec?.branches },
    commits: [...own, ...MAIN_COMMITS],
    ahead: branch === "main" ? 0 : own.length,
    status: spec?.status ?? "",
    diff: spec?.diff ?? "",
    files: new Map(),
    prs: (spec?.prs ?? []).map((pr) => ({ ...pr, state: pr.state ?? "OPEN" })),
    pages: { ...spec?.pages },
    remote: new Map(),
  };
  for (const pr of w.prs) {
    const name = pr.headRefName ?? branch;
    const tip =
      typeof pr.headRefOid === "string"
        ? pr.headRefOid
        : name === branch
          ? head(w).sha
          : shortHash(name);
    w.remote.set(name, tip);
  }
  // A diff implies its files exist, so a case only spells out the files it cares about.
  const diffs = [w.diff, ...w.prs.map((pr) => pr.diff ?? "")].flatMap(diffFiles);
  const implied = Object.fromEntries(diffs.map((file) => [file.path, `${file.after}\n`]));
  for (const [path, content] of Object.entries({ ...DEFAULT_FILES, ...implied, ...spec?.files })) {
    w.files.set(resolvePath(w, path), content);
  }
  return w;
};

const fullSha = (sha: string) => `${sha}e3b0c44298fc1c149afbf4c8996fb92427ae41e4`.slice(0, 40);
const head = (w: World) => w.commits[0] ?? { sha: "0000000", subject: "" };
/** Index into `commits` that a ref points at. History is one line, newest first. */
const refIndex = (w: World, ref = "HEAD"): number => {
  const back = /^(.+?)(?:~(\d*)|\^+)$/.exec(ref);
  if (back)
    return (
      refIndex(w, back[1]) +
      (back[2] === undefined ? ref.length - ref.indexOf("^") : Number(back[2] || 1))
    );
  if (/^(origin\/)?(main|HEAD)$/.test(ref) && ref !== "HEAD") return w.ahead;
  const name = ref.replace(/^origin\//, "");
  const tip = (ref.startsWith("origin/") ? w.remote.get(name) : undefined) ?? w.branches[name];
  const sha = tip ?? (ref.length >= 4 && /^[0-9a-f]+$/.test(ref) ? ref : undefined);
  const found = sha === undefined ? -1 : w.commits.findIndex((c) => fullSha(c.sha).startsWith(sha));
  return found === -1 ? 0 : found;
};
const commitAt = (w: World, ref?: string) => w.commits[refIndex(w, ref)] ?? head(w);
const age = (w: World, c: typeof Commit.Type) =>
  w.commits.indexOf(c) < w.ahead ? "12 minutes ago" : "2 days ago";

/**
 * The gitStatus reminder Claude Code adds when a session starts. Commits and a branch that the
 * case's prior turns made (their tool results show it) are left out, since they came later.
 */
export const gitStatusReminder = (w: World, priorTurns: string) => {
  const made = w.commits.filter((c) => priorTurns.includes(` ${c.sha}] `));
  const newBranch = priorTurns.includes(`Switched to a new branch '${w.branch}'`);
  return [
    "<system-reminder>",
    "As you answer the user's questions, you can use the following context:",
    "# gitStatus",
    "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
    "",
    `Current branch: ${newBranch ? "main" : w.branch}`,
    "",
    "Main branch (you will usually use this for PRs): main",
    "",
    "Status:",
    w.status || "(clean)",
    "",
    "Recent commits:",
    ...w.commits
      .filter((c) => !made.includes(c))
      .slice(0, 5)
      .map((c) => `${c.sha} ${c.subject}`),
    "",
    "Claude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
    "</system-reminder>",
  ].join("\n");
};

const markChanged = (w: World, path: string, created: boolean) => {
  if (!path.startsWith(`${w.cwd}/`)) return;
  const line = `${created ? "??" : " M"} ${relative(w, path)}`;
  if (!w.status.split("\n").includes(line)) w.status = w.status ? `${w.status}\n${line}` : line;
};

type Out = { readonly text: string; readonly ok: boolean };
const ok = (text = ""): Out => ({ text, ok: true });
const fail = (text: string): Out => ({ text, ok: false });
type Handler = (w: World, args: ReadonlyArray<string>) => Out;
const all = (outs: ReadonlyArray<Out>, separator = "\n"): Out => ({
  text: outs.map((out) => out.text).join(separator),
  ok: outs.every((out) => out.ok),
});

const positional = (args: ReadonlyArray<string>, valued: ReadonlyArray<string> = []) =>
  args.filter((arg, i) => !arg.startsWith("-") && !valued.includes(args[i - 1] ?? ""));
const flag = (args: ReadonlyArray<string>, ...names: ReadonlyArray<string>) => {
  for (const [i, arg] of args.entries()) {
    for (const name of names) {
      if (arg === name) return args[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
};
const lineCount = (args: ReadonlyArray<string>, fallback: number) =>
  Number(
    flag(args, "-n", "--max-count") ?? args.find((a) => /^-\d+$/.test(a))?.slice(1) ?? fallback,
  );

const readFile = (w: World, path: string, command: string): Out => {
  const content = w.files.get(resolvePath(w, path));
  if (content !== undefined) return ok(content.replace(/\n$/, ""));
  const isDir = listDir(w, path) !== undefined;
  return fail(`${command}: ${path}: ${isDir ? "Is a directory" : "No such file or directory"}`);
};
const eachFile =
  (
    command: string,
    pick: (lines: Array<string>, args: ReadonlyArray<string>) => Array<string>,
  ): Handler =>
  (w, args) =>
    all(
      positional(args, ["-n", "-c"]).map((path) => {
        const out = readFile(w, path, command);
        return out.ok ? ok(pick(out.text.split("\n"), args).join("\n")) : out;
      }),
    );
const sedLines = (lines: Array<string>, script: string) => {
  const range = /^(\d+)(?:,(\d+|\$))?p$/.exec(script);
  if (!range) return lines;
  const last = range[2] === undefined ? range[1] : range[2] === "$" ? lines.length : range[2];
  return lines.slice(Number(range[1]) - 1, Number(last));
};

/** Files and directories directly under `path`, or undefined when it does not exist. */
const listDir = (w: World, path: string) => {
  const dir = resolvePath(w, path);
  if (w.files.has(dir)) return [path];
  const names = [...w.files.keys()].flatMap((key) =>
    key.startsWith(`${dir}/`) ? [key.slice(dir.length + 1).split("/")[0] ?? ""] : [],
  );
  return names.length > 0 || dir === w.cwd || dir === "/tmp"
    ? [...new Set(names)].toSorted()
    : undefined;
};
const filesUnder = (w: World, paths: ReadonlyArray<string>) =>
  [...w.files.keys()].filter((key) =>
    (paths.length === 0 ? [w.dir] : paths.map((p) => resolvePath(w, p))).some(
      (path) => key === path || key.startsWith(`${path}/`),
    ),
  );

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const grep: Handler = (w, args) => {
  const valued = [
    "-e",
    "-g",
    "--glob",
    "-t",
    "--type",
    "-A",
    "-B",
    "-C",
    "-m",
    "--include",
    "--exclude-dir",
  ];
  const rest = positional(args, valued);
  const [pattern = "", ...paths] =
    flag(args, "-e") === undefined ? rest : [flag(args, "-e") ?? "", ...rest];
  const short = args.filter((arg) => /^-[a-zA-Z]+$/.test(arg)).join("");
  let regex: RegExp;
  try {
    regex = new RegExp(
      args.includes("-F") ? escapeRegex(pattern) : pattern.replaceAll("\\|", "|"),
      short.includes("i") ? "i" : "",
    );
  } catch {
    regex = new RegExp(escapeRegex(pattern));
  }
  const hits = filesUnder(w, paths).flatMap((key) =>
    (w.files.get(key) ?? "")
      .split("\n")
      .flatMap((line, i) =>
        regex.test(line)
          ? [{ path: relative(w, key), text: `${relative(w, key)}:${i + 1}:${line}` }]
          : [],
      ),
  );
  if (hits.length === 0) return fail("");
  return ok(
    short.includes("l")
      ? [...new Set(hits.map((hit) => hit.path))].join("\n")
      : hits.map((hit) => hit.text).join("\n"),
  );
};

const diffStat = (diff: string) => {
  const files = diffFiles(diff);
  if (files.length === 0) return "";
  const sum = (key: "added" | "removed") => files.reduce((total, f) => total + f[key], 0);
  return [
    ...files.map(
      (f) => ` ${f.path} | ${f.added + f.removed} ${"+".repeat(f.added)}${"-".repeat(f.removed)}`,
    ),
    ` ${files.length} files changed, ${sum("added")} insertions(+), ${sum("removed")} deletions(-)`,
  ].join("\n");
};
const shortHash = (text: string) => {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 7);
};
const logLine = (w: World, c: typeof Commit.Type, format: string | undefined) =>
  format === undefined || format === "oneline"
    ? `${c.sha} ${c.subject}`
    : format
        .replace(/^t?format:/, "")
        .replaceAll("%H", fullSha(c.sha))
        .replaceAll("%h", c.sha)
        .replaceAll("%s", c.subject)
        .replace(/%a[ne]/g, "Acme Dev")
        .replace(/%[ac][dr]/g, age(w, c))
        .replace(/%[a-zA-Z]/g, "");

const checkout: Handler = (w, args) => {
  const created = flag(args, "-b", "-B", "-c", "-C");
  const target = created ?? positional(args)[0];
  if (target === undefined || args.includes("--")) return ok();
  if (created !== undefined) {
    w.branches[w.branch] = head(w).sha;
    w.ahead = 0;
  }
  w.branch = target;
  return ok(
    created === undefined
      ? `Switched to branch '${target}'`
      : `Switched to a new branch '${target}'`,
  );
};

const GIT: Readonly<Record<string, Handler>> = {
  status: (w, args) => {
    if (args.some((a) => /^-\w*s|^--(short|porcelain)/.test(a))) {
      const branchLine = args.some((a) => /^-\w*b|^--branch/.test(a)) ? [`## ${w.branch}`] : [];
      return ok([...branchLine, ...(w.status ? [w.status] : [])].join("\n"));
    }
    const changes = w.status
      ? `Changes not staged for commit:\n${w.status
          .split("\n")
          .map((l) => `\t${l.trim()}`)
          .join("\n")}`
      : "nothing to commit, working tree clean";
    return ok(`On branch ${w.branch}\n${changes}`);
  },
  log: (w, args) => {
    const [ref] = positional(args, ["-n", "--author", "--since", "--grep"]).filter(
      (a) => a !== "--",
    );
    const range = ref?.split(/\.{2,3}/);
    const from = refIndex(w, range?.[1] || ref);
    const to = range?.length === 2 ? refIndex(w, range[0]) : w.commits.length;
    const commits = w.commits.slice(from, Math.max(from, to)).slice(0, lineCount(args, 20));
    const format =
      flag(args, "--format", "--pretty") ?? (args.includes("--oneline") ? undefined : "");
    if (format !== "") return ok(commits.map((c) => logLine(w, c, format)).join("\n"));
    return ok(
      commits
        .map(
          (c) =>
            `commit ${fullSha(c.sha)}\nAuthor: Acme Dev <dev@acme.test>\nDate:   ${age(w, c)}\n\n    ${c.subject}\n`,
        )
        .join("\n"),
    );
  },
  branch: (w, args) => {
    if (args.includes("--show-current")) return ok(w.branch);
    const names = [...new Set([w.branch, "main", ...Object.keys(w.branches)])];
    const verbose = args.some((a) => /^-v/.test(a));
    return ok(
      names
        .map((name) => {
          const c = commitAt(w, name === w.branch ? "HEAD" : name);
          return `${name === w.branch ? "*" : " "} ${name}${verbose ? ` ${c.sha} ${c.subject}` : ""}`;
        })
        .join("\n"),
    );
  },
  "rev-parse": (w, args) => {
    if (args.includes("--show-toplevel")) return ok(w.cwd);
    if (args.includes("--is-inside-work-tree")) return ok("true");
    if (args.some((a) => /@\{u(pstream)?\}/.test(a))) {
      return w.remote.has(w.branch)
        ? ok(`origin/${w.branch}`)
        : fail(`fatal: no upstream configured for branch '${w.branch}'`);
    }
    if (args.includes("--abbrev-ref")) return ok(w.branch);
    const refs = positional(args);
    const shas = (refs.length > 0 ? refs : ["HEAD"]).map((ref) => commitAt(w, ref).sha);
    return ok(shas.map((sha) => (args.includes("--short") ? sha : fullSha(sha))).join("\n"));
  },
  diff: (w, args) => {
    const ranged = args.some((a) =>
      /\.\.|^(origin\/)?main$|^HEAD|^[0-9a-f]{7,}$|^--(cached|staged)$/.test(a),
    );
    const diff = ranged || w.status ? w.diff : "";
    if (args.includes("--stat")) return ok(diffStat(diff));
    if (args.includes("--name-only"))
      return ok(
        diffFiles(diff)
          .map((f) => f.path)
          .join("\n"),
      );
    return ok(diff);
  },
  show: (w, args) => {
    const [target = "HEAD"] = positional(args, ["--format", "--pretty"]);
    // REF:path prints the file at REF. Before the branch's commits, a changed file is the diff's old side.
    const [ref = "HEAD", path] = target.split(":");
    if (path !== undefined) {
      const changed = diffFiles(w.diff).find((f) => f.path === path);
      if (changed === undefined || refIndex(w, ref) < w.ahead) return readFile(w, path, "git show");
      return changed.before
        ? ok(changed.before)
        : fail(`fatal: path '${path}' exists on disk, but not in '${ref}'`);
    }
    const c = commitAt(w, target);
    const message = [c.subject, ...(c.body ? ["", c.body] : [])].map((l) => `    ${l}`).join("\n");
    const header = `commit ${fullSha(c.sha)}\nAuthor: Acme Dev <dev@acme.test>\nDate:   ${age(w, c)}\n\n${message}\n`;
    const diff = w.commits.indexOf(c) < Math.max(w.ahead, 1) ? w.diff : "";
    return ok(`${header}\n${args.includes("--stat") ? diffStat(diff) : diff}`);
  },
  remote: (w, args) =>
    ok(
      args.includes("-v")
        ? `origin\tgit@github.com:${w.repo}.git (fetch)\norigin\tgit@github.com:${w.repo}.git (push)`
        : args.includes("get-url")
          ? `git@github.com:${w.repo}.git`
          : "origin",
    ),
  push: (w, args) => {
    const [, ...refs] = positional(args);
    const branches = (refs.length > 0 ? refs : [w.branch]).map((ref) =>
      ref === "HEAD" ? w.branch : (ref.split(":").at(-1) ?? ref).replace(/^refs\/heads\//, ""),
    );
    const lines = branches.map((b) => {
      const old = w.remote.get(b);
      const tip = commitAt(w, b === w.branch ? "HEAD" : b).sha;
      w.remote.set(b, tip);
      if (old === undefined) return ` * [new branch]      ${b} -> ${b}`;
      return old.startsWith(tip)
        ? "Everything up-to-date"
        : `   ${old.slice(0, 7)}..${tip}  ${b} -> ${b}`;
    });
    return ok(`To github.com:${w.repo}.git\n${lines.join("\n")}`);
  },
  "ls-remote": (w) =>
    ok(
      [["main", commitAt(w, "main").sha], ...w.remote]
        .map(([b, sha]) => `${fullSha(sha ?? "")}\trefs/heads/${b}`)
        .join("\n"),
    ),
  pull: () => ok("Already up to date."),
  merge: () => ok("Already up to date."),
  rebase: (w) => ok(`Current branch ${w.branch} is up to date.`),
  checkout,
  switch: checkout,
  commit: (w, args) => {
    const amend = args.includes("--amend");
    if (!w.status && !amend && !args.includes("--allow-empty"))
      return fail(`On branch ${w.branch}\nnothing to commit, working tree clean`);
    const file = flag(args, "-F", "--file");
    const message =
      flag(args, "-m", "-am", "--message") ??
      (file === undefined ? undefined : w.files.get(resolvePath(w, file)));
    const subject = message?.split("\n")[0] || (amend ? head(w).subject : "Update");
    const sha = shortHash(`${subject}${w.commits.length}${w.status}`);
    if (amend) w.commits.shift();
    else w.ahead++;
    w.commits.unshift({ sha, subject });
    const changed = w.status.split("\n").length;
    w.status = "";
    return ok(`[${w.branch} ${sha}] ${subject}\n ${changed} file${changed > 1 ? "s" : ""} changed`);
  },
  "ls-files": (w) =>
    ok(
      [...w.files.keys()]
        .filter((key) => key.startsWith(`${w.cwd}/`))
        .map((key) => relative(w, key))
        .join("\n"),
    ),
  grep,
};

const prUrl = (w: World, number: number) => `https://github.com/${w.repo}/pull/${number}`;
const prDiff = (w: World, pr: Pr) =>
  pr.diff ?? ((pr.headRefName ?? w.branch) === w.branch ? w.diff : "");
/** The JSON `gh pr view --json` would show, with the case's own keys on top. */
const prJson = (w: World, pr: Pr): Record<string, unknown> => {
  const { checks = [{ name: "ci", state: "pass" }], diff: _diff, headRefOid: _tip, ...rest } = pr;
  const headRefName = pr.headRefName ?? w.branch;
  const merged = pr.state === "MERGED";
  const [owner, name] = w.repo.split("/");
  const tip = w.remote.get(headRefName) ?? shortHash(headRefName);
  const headRefOid = fullSha(tip);
  const headCommit = w.commits.find((c) => headRefOid.startsWith(c.sha));
  return {
    url: prUrl(w, pr.number),
    isDraft: false,
    headRefName,
    baseRefName: "main",
    headRefOid,
    headRepository: { name },
    headRepositoryOwner: { login: owner },
    isCrossRepository: false,
    maintainerCanModify: true,
    commits: [{ oid: headRefOid, messageHeadline: headCommit?.subject ?? pr.title }],
    author: { login: "acme-dev" },
    body: "",
    files: diffFiles(prDiff(w, pr)).map((f) => ({
      path: f.path,
      additions: f.added,
      deletions: f.removed,
    })),
    mergeable: merged ? "UNKNOWN" : "MERGEABLE",
    mergeStateStatus: merged
      ? "UNKNOWN"
      : checks.every((c) => c.state === "pass")
        ? "CLEAN"
        : "BLOCKED",
    mergedAt: merged ? "2026-10-23T18:04:00Z" : null,
    reviewDecision: "",
    statusCheckRollup: checks.map((c) => ({
      name: c.name,
      status: c.state === "pending" ? "IN_PROGRESS" : "COMPLETED",
      conclusion: { pass: "SUCCESS", fail: "FAILURE" }[c.state] ?? "",
    })),
    ...rest,
  };
};
const jsonOut = (value: unknown, args: ReadonlyArray<string>) => {
  const jq = flag(args, "--jq", "-q");
  const field = jq === undefined ? undefined : /^\.(\w+)$/.exec(jq)?.[1];
  const picked =
    field === undefined || !value || typeof value !== "object"
      ? value
      : (value as Record<string, unknown>)[field];
  return ok(
    typeof picked === "string"
      ? picked
      : JSON.stringify(picked ?? null, null, jq === undefined ? 2 : undefined),
  );
};
const pick = (value: Record<string, unknown>, fields: string | undefined) =>
  fields === undefined
    ? value
    : Object.fromEntries(fields.split(",").map((key) => [key, value[key] ?? null]));
const GH_VALUED = [
  "-R",
  "--repo",
  "--json",
  "--jq",
  "-q",
  "--state",
  "-s",
  "--limit",
  "-L",
  "--search",
  "--author",
  "--label",
  "--base",
  "-B",
  "--head",
  "-H",
  "--title",
  "-t",
  "--body",
  "-b",
  "--body-file",
  "-F",
];

const valueText = (value: unknown) => (typeof value === "string" ? value : "acme-dev");
/** A PR body from `--body`, or from the file `--body-file` names. */
const prBody = (w: World, args: ReadonlyArray<string>) => {
  const file = flag(args, "--body-file", "-F");
  return (
    flag(args, "--body", "-b") ??
    (file === undefined ? undefined : w.files.get(resolvePath(w, file)))
  );
};
const findPr = (w: World, args: ReadonlyArray<string>) => {
  const target = positional(args, GH_VALUED)[0];
  const number = Number(/(\d+)\/?$/.exec(target ?? "")?.[1] ?? Number.NaN);
  return w.prs.find((pr) =>
    Number.isNaN(number)
      ? (pr.headRefName ?? w.branch) === (target ?? w.branch)
      : pr.number === number,
  );
};
const withPr =
  (run: (w: World, pr: Pr, args: ReadonlyArray<string>) => Out): Handler =>
  (w, args) => {
    const pr = findPr(w, args);
    return pr === undefined
      ? fail(`no pull requests found for branch "${w.branch}"`)
      : run(w, pr, args);
  };
const GH_PR: Readonly<Record<string, Handler>> = {
  view: withPr((w, pr, args) => {
    const json = prJson(w, pr);
    if (flag(args, "--json") !== undefined) return jsonOut(pick(json, flag(args, "--json")), args);
    const state = `${pr.state[0] ?? ""}${pr.state.slice(1).toLowerCase()}`;
    return ok(
      `${pr.title} #${pr.number}\n${state} • ${valueText((json.author as { login?: string }).login)} wants to merge into ${String(json.baseRefName)} from ${String(json.headRefName)}\n\n${String(json.body) || "No description provided"}\n\nView this pull request on GitHub: ${prUrl(w, pr.number)}`,
    );
  }),
  list: (w, args) => {
    const state = (flag(args, "--state", "-s") ?? "open").toUpperCase();
    const prs = w.prs.filter((pr) => state === "ALL" || pr.state === state);
    const fields = flag(args, "--json");
    if (fields !== undefined)
      return jsonOut(
        prs.map((pr) => pick(prJson(w, pr), fields)),
        args,
      );
    return ok(
      prs
        .map((pr) => `${pr.number}\t${pr.title}\t${String(prJson(w, pr).headRefName)}\t${pr.state}`)
        .join("\n"),
    );
  },
  create: (w, args) => {
    const headRefName = flag(args, "--head", "-H") ?? w.branch;
    const existing = w.prs.find((pr) => pr.headRefName === headRefName && pr.state === "OPEN");
    if (existing !== undefined)
      return fail(
        `a pull request for branch "${headRefName}" into branch "main" already exists:\n${prUrl(w, existing.number)}`,
      );
    const number = Math.max(123, ...w.prs.map((pr) => pr.number)) + 1;
    const title = flag(args, "--title", "-t") ?? commitAt(w, headRefName).subject;
    if (!w.remote.has(headRefName)) w.remote.set(headRefName, commitAt(w, headRefName).sha);
    w.prs.push({
      number,
      title,
      body: prBody(w, args) ?? "",
      headRefName,
      state: "OPEN",
      baseRefName: flag(args, "--base", "-B") ?? "main",
      checks: [{ name: "ci", state: "pending" }],
    });
    return ok(prUrl(w, number));
  },
  checks: withPr((w, pr) =>
    ok(
      (pr.checks ?? [{ name: "ci", state: "pass" }])
        .map(
          (c) =>
            `${c.name}\t${c.state}\t${c.state === "pending" ? "0" : "1m12s"}\thttps://github.com/${w.repo}/actions/runs/1`,
        )
        .join("\n"),
    ),
  ),
  diff: withPr((w, pr) => ok(prDiff(w, pr))),
  merge: withPr((w, pr, args) => {
    if (args.includes("--auto"))
      return ok(
        `✓ Pull request ${w.repo}#${pr.number} will be automatically merged via squash when all requirements are met`,
      );
    pr.state = "MERGED";
    return ok(`✓ Squashed and merged pull request ${w.repo}#${pr.number} (${pr.title})`);
  }),
  checkout: withPr((w, pr) => {
    w.branch = pr.headRefName ?? w.branch;
    return ok(`Switched to branch '${w.branch}'`);
  }),
  comment: withPr((w, pr) => ok(`${prUrl(w, pr.number)}#issuecomment-1`)),
  edit: withPr((w, pr, args) => {
    const title = flag(args, "--title", "-t") ?? pr.title;
    w.prs[w.prs.indexOf(pr)] = { ...pr, title, body: prBody(w, args) ?? pr.body };
    return ok(prUrl(w, pr.number));
  }),
};
const gh: Handler = (w, [group = "", sub = "", ...args]) => {
  if (group === "pr") return (GH_PR[sub] ?? (() => ok()))(w, args);
  if (group === "repo" && sub === "view") {
    const json = {
      nameWithOwner: w.repo,
      url: `https://github.com/${w.repo}`,
      defaultBranchRef: { name: "main" },
    };
    return flag(args, "--json") === undefined ? ok(w.repo) : jsonOut(json, args);
  }
  if (group === "auth")
    return ok("github.com\n  ✓ Logged in to github.com account acme-dev (keyring)");
  return ok();
};

/** The page at a URL: the longest matching `pages` prefix, else an empty page. */
export const webPage = (w: World, url: string) => {
  const key = Object.keys(w.pages)
    .filter(
      (prefix) => url.startsWith(prefix) || url.replace(/\/$/, "") === prefix.replace(/\/$/, ""),
    )
    .toSorted((a, b) => b.length - a.length)[0];
  return key === undefined
    ? `<!doctype html><html><head><title>${new URL(url, "http://localhost").host}</title></head><body></body></html>`
    : (w.pages[key] ?? "");
};
const curl: Handler = (w, args) => {
  const url =
    positional(args, ["-o", "-w", "-m", "--max-time", "-H", "-X", "-d", "--data", "-A", "-u"]).find(
      (a) => /^https?:\/\/|^localhost/.test(a),
    ) ?? "";
  const page = webPage(w, url);
  const out = flag(args, "-o", "--output");
  if (out !== undefined && out !== "/dev/null") w.files.set(resolvePath(w, out), page);
  const format = flag(args, "-w", "--write-out");
  if (format !== undefined)
    return ok(
      format
        .replaceAll("%{http_code}", "200")
        .replaceAll("%{size_download}", String(page.length))
        .replaceAll("\\n", "\n")
        .trimEnd(),
    );
  if (args.some((a) => /^-\w*I$|^--head$/.test(a)))
    return ok("HTTP/2 200\ncontent-type: text/html; charset=utf-8");
  return ok(out === undefined ? page : "");
};

const TEST_PASS = " Test Files  4 passed (4)\n      Tests  31 passed (31)\n   Duration  2.84s";
/** pnpm, npm, yarn, bun, and vp: installs and scripts succeed; test runs pass. */
const packageManager: Handler = (_, args) => {
  const [command = "", script = ""] = positional(args, ["--filter", "-F", "-C", "--dir"]);
  if (args.includes("-v") || args.includes("--version")) return ok("10.4.0");
  if (["install", "i", "add", "ci"].includes(command))
    return ok("Lockfile is up to date, resolution step is skipped\nDone in 1.9s");
  if ([command, script].some((word) => /^(test|vitest)$/.test(word))) return ok(TEST_PASS);
  return ok();
};

const COMMANDS: Readonly<Record<string, Handler>> = {
  echo: (_, args) => ok(args.filter((arg) => !/^-[neE]+$/.test(arg)).join(" ")),
  printf: (_, [format = "", ...args]) =>
    ok(
      format
        .replace(/%[sd]/g, () => args.shift() ?? "")
        .replaceAll("\\n", "\n")
        .trimEnd(),
    ),
  pwd: (w) => ok(w.dir),
  cd: (w, [path = "~"]) => {
    if (listDir(w, path) === undefined) return fail(`cd: ${path}: No such file or directory`);
    w.dir = resolvePath(w, path);
    return ok();
  },
  uname: (w) => ok(w.platform === "darwin" ? "Darwin" : "Linux"),
  // Every tool the agent asks about is installed.
  which: (_, args) =>
    ok(
      positional(args)
        .map((name) => `/usr/local/bin/${name}`)
        .join("\n"),
    ),
  command: (_, args) =>
    ok(
      args[0] === "-v"
        ? args
            .slice(1)
            .map((name) => `/usr/local/bin/${name}`)
            .join("\n")
        : "",
    ),
  node: (_, args) => ok(args.includes("-v") || args.includes("--version") ? "v24.15.0" : ""),
  pnpm: packageManager,
  npm: packageManager,
  yarn: packageManager,
  bun: packageManager,
  vp: packageManager,
  npx: (w, args) => (args[0] === "vitest" ? ok(TEST_PASS) : ok()),
  false: () => fail(""),
  ls: (w, args) => {
    const paths = positional(args);
    return all(
      (paths.length > 0 ? paths : ["."]).map((path) => {
        const names = listDir(w, path);
        if (names === undefined)
          return fail(`ls: cannot access '${path}': No such file or directory`);
        return ok(paths.length > 1 ? `${path}:\n${names.join("\n")}` : names.join("\n"));
      }),
      "\n\n",
    );
  },
  cat: eachFile("cat", (lines) => lines),
  head: eachFile("head", (lines, args) => lines.slice(0, lineCount(args, 10))),
  tail: eachFile("tail", (lines, args) => lines.slice(-lineCount(args, 10))),
  wc: (w, args) =>
    all(
      positional(args).map((path) => {
        const out = readFile(w, path, "wc");
        return out.ok
          ? ok(
              `${out.text.split("\n").length} ${args.includes("-l") ? "" : `${out.text.length} `}${path}`,
            )
          : out;
      }),
    ),
  sed: (w, args) => {
    const [script = "", ...paths] = positional(args, ["-e"]).filter((arg) => arg !== "");
    if (args.some((arg) => arg.startsWith("-i"))) {
      // s<d>from<d>to<d>flags, the edit agents use sed -i for.
      const sub = /^s(.)(.*?)\1(.*?)\1(g?)$/.exec(script);
      for (const path of paths) {
        const content = w.files.get(resolvePath(w, path));
        if (content === undefined || sub === null) continue;
        const from = new RegExp(sub[2] ?? "", sub[4] === "g" ? "g" : "");
        w.files.set(resolvePath(w, path), content.replace(from, sub[3] ?? ""));
        markChanged(w, resolvePath(w, path), false);
      }
      return ok();
    }
    return eachFile("sed", (lines) => sedLines(lines, flag(args, "-e") ?? script))(w, paths);
  },
  grep,
  rg: grep,
  find: (w, args) => {
    const [dir = "."] = positional(args, ["-name", "-iname", "-type", "-maxdepth", "-path"]);
    const name = flag(args, "-name", "-iname");
    const glob =
      name === undefined
        ? undefined
        : new RegExp(`^${escapeRegex(name).replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`, "i");
    const found = filesUnder(w, [dir]).filter(
      (key) => glob === undefined || glob.test(key.split("/").at(-1) ?? ""),
    );
    return ok(
      found
        .map((key) =>
          dir === "." ? `./${relative(w, key)}` : key.replace(resolvePath(w, dir), dir),
        )
        .join("\n"),
    );
  },
  mv: (w, args) => {
    const [from = "", to = ""] = positional(args);
    const content = w.files.get(resolvePath(w, from));
    if (content === undefined) return fail(`mv: cannot stat '${from}': No such file or directory`);
    const intoDir = listDir(w, to) !== undefined && !w.files.has(resolvePath(w, to));
    w.files.delete(resolvePath(w, from));
    w.files.set(resolvePath(w, intoDir ? `${to}/${from.split("/").at(-1)}` : to), content);
    return ok();
  },
  rm: (w, args) => {
    for (const path of positional(args)) w.files.delete(resolvePath(w, path));
    return ok();
  },
  curl,
  git: (w, args) => {
    // Global options: -C <dir>, -c <key=value>, --no-pager.
    const rest = args.filter(
      (arg, i) =>
        !["-C", "-c", "--no-pager"].includes(arg) && !["-C", "-c"].includes(args[i - 1] ?? ""),
    );
    return (GIT[rest[0] ?? ""] ?? (() => ok()))(w, rest.slice(1));
  },
  gh,
};

// A shell word with its quotes, and the quote-aware split of one word into text.
const WORD = /(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/g;
const expand = (w: World, text: string) =>
  text
    .replaceAll("$?", "0")
    .replace(/\$\{?(\w+)\}?/g, (_, name: string) => ({ HOME: home(w), PWD: w.dir })[name] ?? "");
const unquote = (w: World, word: string) =>
  word.replace(
    /"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^"'\\]|\\.)+)/g,
    (_, dq?: string, sq?: string, bare?: string) =>
      sq ??
      (dq === undefined
        ? expand(w, (bare ?? "").replace(/\\(.)/g, "$1"))
        : expand(w, dq.replace(/\\(["\\$`])/g, "$1"))),
  );

/** Splits on `&&`, `||`, `;`, `|`, `&`, and newlines outside quotes and parentheses. */
const splitCommand = (command: string) => {
  const parts: Array<{ op: string; text: string }> = [];
  let op = ";";
  let text = "";
  let quote = "";
  let depth = 0;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? "";
    const pair = command.slice(i, i + 2);
    if (quote !== "") {
      if (char === "\\" && quote === '"') {
        text += pair;
        i++;
        continue;
      }
      if (char === quote) quote = "";
    } else if (char === "\\") {
      text += pair;
      i++;
      continue;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (
      depth === 0 &&
      (pair === "&&" ||
        pair === "||" ||
        ";\n|".includes(char) ||
        (char === "&" && !">&".includes(command[i - 1] ?? "") && command[i + 1] !== ">"))
    ) {
      parts.push({ op, text });
      op = pair === "&&" || pair === "||" ? pair : char === "|" ? "|" : ";";
      if (op.length === 2) i++;
      text = "";
      continue;
    }
    text += char;
  }
  parts.push({ op, text });
  return parts.filter((part) => part.text.trim() !== "");
};

type ShellMock = { readonly match: string; readonly output: string };

const runPart = (w: World, mocks: ReadonlyArray<ShellMock>, raw: string): Out => {
  const part = raw.trim().replace(/^(do|then|else|\{)\s+/, "");
  if (/^[})]$|^(for|while|until|if|fi|done|esac|case)\b/.test(part)) return ok();
  const mock = mocks.find(({ match }) => new RegExp(match).test(part));
  if (mock !== undefined) return ok(mock.output);
  // A ( ... ) group runs on its own; a redirect after it applies to the group's output.
  const group = /^\(([\s\S]*)\)\s*((?:\d?>[\s\S]*)?)$/.exec(part);
  const grouped = group ? runCommand(w, mocks, group[1] ?? "") : undefined;
  // $(...) without nesting runs first, like the shell.
  const substituted = (group ? `true ${group[2] ?? ""}` : part).replace(
    /\$\(([^()]*)\)/g,
    (_, inner: string) => runCommand(w, mocks, inner).text.trim(),
  );
  const words = substituted.match(WORD) ?? [];
  const args: Array<string> = [];
  let target: { path: string; append: boolean } | undefined;
  let stdin: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "<<<") {
      stdin = unquote(w, words[++i] ?? "");
      continue;
    }
    const redirect = /^(\d|&)?(>>?)(.*)$/.exec(word);
    if (redirect === null) {
      if (word !== "<") args.push(unquote(w, word));
      else i++;
      continue;
    }
    const dest = redirect[3] || words[++i] || "";
    if (!dest.startsWith("&") && redirect[1] !== "2" && dest !== "/dev/null") {
      target = { path: unquote(w, dest), append: redirect[2] === ">>" };
    }
  }
  while (/^(\w+=\S*|sudo|env|time|nohup)$/.test(args[0] ?? "")) args.shift();
  if (args[0] === "timeout") args.splice(0, 2);
  const [name = "", ...rest] = args;
  // Heredoc input: `cat` prints it; `--body-file -` and `git commit -F -` read it.
  const fromStdin = rest.findIndex(
    (arg, i) => arg === "-" && ["--body-file", "-F", "--file"].includes(rest[i - 1] ?? ""),
  );
  if (stdin !== undefined && fromStdin > 0)
    rest.splice(fromStdin - 1, 2, name === "git" ? "-m" : "--body", stdin);
  const run = COMMANDS[name.split("/").at(-1) ?? ""] ?? (() => ok());
  const out =
    grouped ??
    (stdin !== undefined && name === "cat" && rest.length === 0 ? ok(stdin) : run(w, rest));
  if (target === undefined) return out;
  const path = resolvePath(w, target.path);
  markChanged(w, path, !w.files.has(path));
  w.files.set(path, `${target.append ? (w.files.get(path) ?? "") : ""}${out.text}\n`);
  return { text: "", ok: out.ok };
};

const runCommand = (w: World, mocks: ReadonlyArray<ShellMock>, command: string): Out => {
  // A heredoc becomes one quoted word: `"$(cat <<EOF ...)"` is its text, and other heredocs are
  // input (`<<<`). A simple for loop repeats its body per value.
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const stripped = command
    .replace(
      /("?)\$\(\s*cat\s*<<-?\s*(['"]?)(\w+)\2\s*\n([\s\S]*?)\n\s*\3\s*\)\1/g,
      (...m: Array<string>) => quote(m[4] ?? ""),
    )
    .replace(
      /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\s*\2(?=\s*(?:\n|$|\)))/g,
      (...m: Array<string>) => ` <<< ${quote(m[4] ?? "")}${m[3] ?? ""}`,
    )
    .replace(
      /\bfor (\w+) in ([^;\n]+)[;\n]\s*do\b([\s\S]*?);?\s*done\b/g,
      (_, name: string, values: string, body: string) =>
        values
          .trim()
          .split(/\s+/)
          .map((value) => body.replace(new RegExp(`\\$\\{?${name}\\}?(?!\\w)`, "g"), value))
          .join(";"),
    );
  const outputs: Array<string> = [];
  let last = ok();
  for (const { op, text } of splitCommand(stripped)) {
    // A pipe keeps the first command's output.
    if (op === "|" || (op === "&&" && !last.ok) || (op === "||" && last.ok)) continue;
    last = runPart(w, mocks, text);
    if (last.text !== "") outputs.push(last.text);
  }
  return { text: outputs.join("\n"), ok: last.ok };
};

/**
 * Output for a Bash command. Each part of a compound command uses the first case shell mock that
 * matches it, else a built-in handler, else prints nothing. Claude Code's wording for empty output
 * and failures is kept. `cd` lasts for one command, then the shell is back in the project.
 */
export const runShell = (w: World, mocks: ReadonlyArray<ShellMock>, command: string) => {
  const { text, ok: succeeded } = runCommand(w, mocks, command);
  w.dir = w.cwd;
  if (!succeeded) return { text: `Exit code 1\n${text}`, error: true };
  return { text: text === "" ? "(Bash completed with no output)" : text, error: false };
};

const toolError = (text: string) => ({
  text: `<tool_use_error>${text}</tool_use_error>`,
  error: true,
});

/** Claude Code's Read, Write, and Edit against the world. Undefined for other tools. */
export const runFileTool = (w: World, name: string, input: Readonly<Record<string, unknown>>) => {
  const path = typeof input.file_path === "string" ? resolvePath(w, input.file_path) : "";
  const content = w.files.get(path);
  if (name === "Read") {
    if (content === undefined) {
      return listDir(w, path) === undefined
        ? toolError(`File does not exist. Note: your current working directory is ${w.cwd}.`)
        : toolError("EISDIR: illegal operation on a directory, read");
    }
    const offset = typeof input.offset === "number" ? Math.max(input.offset, 1) : 1;
    const limit = typeof input.limit === "number" ? input.limit : 2000;
    const lines = content
      .replace(/\n$/, "")
      .split("\n")
      .slice(offset - 1, offset - 1 + limit);
    return {
      text: lines.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join("\n"),
      error: false,
    };
  }
  if (name === "Write") {
    w.files.set(path, typeof input.content === "string" ? input.content : "");
    markChanged(w, path, content === undefined);
    return { text: `File created successfully at: ${path}`, error: false };
  }
  if (name === "Edit") {
    const from = typeof input.old_string === "string" ? input.old_string : "";
    const to = typeof input.new_string === "string" ? input.new_string : "";
    if (content === undefined) return toolError("File does not exist.");
    if (!content.includes(from))
      return toolError(`String to replace not found in file.\nString: ${from}`);
    w.files.set(
      path,
      input.replace_all === true ? content.replaceAll(from, to) : content.replace(from, to),
    );
    markChanged(w, path, false);
    return { text: `The file ${path} has been updated successfully.`, error: false };
  }
  return undefined;
};
