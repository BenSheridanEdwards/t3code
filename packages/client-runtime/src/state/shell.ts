import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import type { ShellResumeBasis } from "../platform/orchestrationCache.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import { subscribeDynamicWithAttempt, type SubscriptionAttempt } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import type { DeferredShellSnapshot } from "./shellPullRequests.ts";
import {
  applyShellStreamEvent,
  mergeShellSnapshotProjects,
  reuseUnchangedThreadShells,
  sameThreadPullRequests,
} from "./shellReducer.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationV2ShellSnapshot>;
  readonly status: EnvironmentShellStatus;
  readonly error: Option.Option<string>;
  /**
   * Changes with each authoritative snapshot (not enrichment refreshes) and when the resume of a
   * cached shell completes; 0 until the first. Thread families read for an older generation may
   * miss changes from before it, so they are read again.
   */
  readonly generation: number;
  /** Sequences of the thread removals applied since the generation last changed. */
  readonly removedAt: ReadonlyMap<ThreadId, number>;
}

const EMPTY_REMOVALS: ReadonlyMap<ThreadId, number> = new Map();
// Shared by every shell state, so a rebuilt one never reuses a generation another already used.
let lastShellGeneration = 0;
// A new session resumes a shell only this long after its latest authoritative snapshot, so rows a
// fresh snapshot would leave out (idle subagent children, settled threads) do not pile up.
const SHELL_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
  generation: 0,
  removedAt: EMPTY_REMOVALS,
};

function shellStatusForSnapshot(
  snapshot: Option.Option<OrchestrationV2ShellSnapshot>,
): EnvironmentShellStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

function withoutDeferredPullRequests(value: DeferredShellSnapshot): OrchestrationV2ShellSnapshot {
  if (value.loadPullRequests === undefined) return value;
  const { loadPullRequests: _deferred, ...snapshot } = value;
  return snapshot;
}

/** A snapshot to save, kept with what it was synchronized against. */
interface PersistedShell {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly resume: ShellResumeBasis | undefined;
}

function samePersistedShell(left: PersistedShell, right: PersistedShell | undefined): boolean {
  return (
    left.snapshot === right?.snapshot &&
    left.resume?.key === right.resume?.key &&
    left.resume?.syncedAt === right.resume?.syncedAt
  );
}

/** The subscription attempt whose items apply. */
interface ActiveAttempt {
  readonly attempt: SubscriptionAttempt;
  readonly resumeKey: string | undefined;
  readonly synchronized: boolean;
}

const encodeResumeKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ server: Schema.String, client: Schema.String, selection: Schema.Unknown }),
  ),
);

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const snapshotLoader = yield* ShellSnapshotLoader.ShellSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const build = Option.getOrUndefined(
    yield* Effect.serviceOption(ClientCapabilities.ClientPresentation),
  )?.build;
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadShell(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.").pipe(
        Effect.annotateLogs({
          environmentId,
          ...safeErrorLogAttributes(error),
        }),
        Effect.as(Option.none<Persistence.CachedEnvironmentShell>()),
      ),
    ),
  );
  const cachedSnapshot = Option.map(cached, (value) => withoutDeferredPullRequests(value.snapshot));
  const cachedResume = Option.getOrUndefined(cached)?.resume;
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    ...EMPTY_SHELL_STATE,
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
  });
  const awaitingCompletion = yield* Ref.make(false);
  // The session whose own authoritative snapshot or completed resume the shell holds.
  const lastAuthoritativeSession = yield* Ref.make<RpcSession | null>(null);
  const activeAttempt = yield* Ref.make<ActiveAttempt | null>(null);
  // What the shell was synchronized against; another session resumes it only with the same key.
  const resumeBasis = yield* Ref.make<ShellResumeBasis | undefined>(cachedResume);
  const latestLiveShell = yield* Ref.make<Option.Option<PersistedShell>>(Option.none());
  const persistence = yield* Queue.sliding<OrchestrationV2ShellSnapshot>(1);

  const persistenceLock = yield* Semaphore.make(1);
  // The loaded cache is already saved, so a resume that changes nothing writes nothing.
  let lastPersisted: PersistedShell | undefined = Option.match(cachedSnapshot, {
    onNone: () => undefined,
    onSome: (snapshot) => ({ snapshot, resume: cachedResume }),
  });
  // Rows still waiting for their deferred pull request links, which must not be saved:
  // the cache would keep them without links until the next server refresh.
  let pendingLinkRows: ReadonlySet<OrchestrationV2ThreadShell> = new Set();
  const persistLatest = Effect.fn("EnvironmentShellState.persistLatest")(function* (
    flush: boolean,
  ) {
    while (true) {
      const latest = yield* Ref.get(latestLiveShell);
      if (Option.isNone(latest) || samePersistedShell(latest.value, lastPersisted)) return;
      if (latest.value.snapshot.threads.some((thread) => pendingLinkRows.has(thread))) return;
      const shell = latest.value;
      const saved = yield* cache.saveShell(environmentId, shell.snapshot, shell.resume).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist environment shell cache.").pipe(
            Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
            Effect.as(false),
          ),
        ),
      );
      if (!saved) return;
      lastPersisted = shell;
      if (!flush) return;
    }
  }, persistenceLock.withPermit);
  const persist = () => persistLatest(false);
  const flushLiveShellSnapshot = persistLatest(true);

  // Register before scoped worker fibers so reverse finalizer order interrupts
  // those fibers first and this flush sees a stable latestLiveShell.
  yield* Effect.addFinalizer(() => flushLiveShellSnapshot);

  yield* runCachePersistence(persistence, persist).pipe(Effect.forkScoped);

  const setDisconnected = Ref.set(awaitingCompletion, false).pipe(
    Effect.andThen(
      SubscriptionRef.update(state, (current) => ({
        ...current,
        status: shellStatusForSnapshot(current.snapshot),
      })),
    ),
    Effect.andThen(flushLiveShellSnapshot.pipe(Effect.forkScoped)),
    Effect.asVoid,
  );
  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setStreamError = (error: unknown) =>
    Ref.set(awaitingCompletion, false).pipe(
      // A resume through the basis that fails before its marker may fail every time, so the next
      // attempt loads HTTP. Memory only: the saved pair keeps its key until the next save.
      Effect.andThen(Effect.all([Ref.get(activeAttempt), Ref.get(lastAuthoritativeSession)])),
      Effect.flatMap(([active, credited]) =>
        active === null || active.synchronized || active.attempt.session === credited
          ? Effect.void
          : Ref.set(resumeBasis, undefined),
      ),
      Effect.andThen(Effect.logWarning("Could not synchronize the environment shell.")),
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  // Server items and deferred link fills both read the snapshot and write it back; one at a
  // time, so neither can overwrite what the other wrote in between.
  const snapshotWriteLock = yield* Semaphore.make(1);

  const applyItems = Effect.fn("EnvironmentShellState.applyItems")(function* (
    items: ReadonlyArray<readonly [SubscriptionAttempt, OrchestrationV2ShellStreamItem]>,
    pendingLinkIds?: ReadonlySet<ThreadId>,
  ) {
    const active = yield* Ref.get(activeAttempt);
    if (active === null) return;
    const initial = yield* SubscriptionRef.get(state);
    let waiting = yield* Ref.get(awaitingCompletion);
    const initialBasis = yield* Ref.get(resumeBasis);
    let basis = initialBasis;
    let synchronized = active.synchronized;
    let credited = false;
    let next = initial;
    for (const [attempt, item] of items) {
      // Buffered from a replaced attempt, which started from an older cursor or snapshot; the
      // active attempt subscribed from the cursor before it, so nothing is lost.
      if (attempt !== active.attempt) continue;
      if (item.kind === "synchronized") {
        waiting = false;
        synchronized = true;
        if (Option.isSome(next.snapshot)) {
          credited = true;
          next = {
            ...next,
            status: "live",
            error: Option.none(),
            // A resumed cache is authoritative once its replay completes. No family read settles
            // at generation 0, so clearing the removals loses nothing.
            ...(next.generation === 0
              ? { generation: ++lastShellGeneration, removedAt: EMPTY_REMOVALS }
              : {}),
          };
        }
        continue;
      }
      const authoritative =
        item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined;
      const nextSnapshot =
        item.kind === "snapshot"
          ? mergeShellSnapshotProjects(
              Option.getOrNull(next.snapshot),
              item.snapshot,
              item.resolvedRepositoryIdentityRoots === undefined
                ? undefined
                : {
                    resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots,
                  },
            )
          : Option.match(next.snapshot, {
              onNone: () => null,
              onSome: (snapshot) =>
                item.sequence > snapshot.snapshotSequence
                  ? applyShellStreamEvent(snapshot, item)
                  : snapshot,
            });
      if (nextSnapshot === null) continue;
      if (authoritative) {
        credited = true;
        basis =
          active.resumeKey === undefined
            ? undefined
            : { key: active.resumeKey, syncedAt: yield* Clock.currentTimeMillis };
      }
      const removal =
        item.kind === "thread.removed" &&
        Option.exists(next.snapshot, (snapshot) => item.sequence > snapshot.snapshotSequence)
          ? item
          : null;
      next = {
        snapshot: Option.some(nextSnapshot),
        status: waiting ? "synchronizing" : "live",
        error: Option.none(),
        generation: authoritative ? ++lastShellGeneration : next.generation,
        removedAt: authoritative
          ? EMPTY_REMOVALS
          : removal === null
            ? next.removedAt
            : new Map(next.removedAt).set(removal.threadId, removal.sequence),
      };
    }
    yield* Ref.set(awaitingCompletion, waiting);
    // Written only when a snapshot set it, so a stream error that cleared it meanwhile stands.
    if (basis !== initialBasis) yield* Ref.set(resumeBasis, basis);
    if (synchronized !== active.synchronized) {
      yield* Ref.set(activeAttempt, { ...active, synchronized });
    }
    if (credited) yield* Ref.set(lastAuthoritativeSession, active.attempt.session);
    if (next === initial) return;
    if (pendingLinkIds !== undefined && Option.isSome(next.snapshot)) {
      pendingLinkRows = new Set(
        next.snapshot.value.threads.filter((thread) => pendingLinkIds.has(thread.id)),
      );
    }
    if (Option.isSome(next.snapshot)) {
      yield* Ref.set(
        latestLiveShell,
        Option.some({ snapshot: next.snapshot.value, resume: basis }),
      );
    }
    yield* SubscriptionRef.set(state, next);
    if (next.snapshot !== initial.snapshot && Option.isSome(next.snapshot)) {
      yield* Queue.offer(persistence, next.snapshot.value);
    }
  }, snapshotWriteLock.withPermit);

  const stateScope = yield* Effect.scope;
  // Each full snapshot supersedes the previous one's fill; links from an older snapshot must
  // not land on rows a newer snapshot reused.

  let activeFill: Fiber.Fiber<void> | undefined;
  const cancelActiveFill = Effect.suspend(() => {
    const fill = activeFill;
    activeFill = undefined;
    return fill === undefined ? Effect.void : Fiber.interrupt(fill);
  });
  const fillDeferredPullRequests = Effect.fnUntraced(function* (
    source: DeferredShellSnapshot,
    applied: OrchestrationV2ShellSnapshot,
  ) {
    yield* cancelActiveFill;
    if (source.loadPullRequests === undefined) return;
    const arrivedRows = new Set(applied.threads);
    const arrivedIds = new Set(source.threads.map((thread) => thread.id));
    pendingLinkRows = new Set(applied.threads.filter((thread) => arrivedIds.has(thread.id)));
    activeFill = yield* source.loadPullRequests.pipe(
      Effect.flatMap((linksByThreadId) =>
        writeFilledLinks(linksByThreadId, arrivedRows, arrivedIds),
      ),
      Effect.forkIn(stateScope),
    );
  });
  const writeFilledLinks = Effect.fnUntraced(
    function* (
      linksByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<ThreadPullRequestLink>>,
      arrivedRows: ReadonlySet<OrchestrationV2ThreadShell>,
      arrivedIds: ReadonlySet<ThreadId>,
    ) {
      const filled = yield* SubscriptionRef.modify(
        state,
        (current): [Option.Option<OrchestrationV2ShellSnapshot>, EnvironmentShellState] => {
          if (Option.isNone(current.snapshot)) return [Option.none(), current];
          const snapshot = current.snapshot.value;
          let changed = false;
          const threads = snapshot.threads.map((thread) => {
            if (!arrivedRows.has(thread) || !arrivedIds.has(thread.id)) return thread;
            const links = linksByThreadId.get(thread.id);
            if (sameThreadPullRequests(thread.pullRequests, links)) return thread;
            changed = true;
            if (links === undefined) {
              const { pullRequests: _previous, ...row } = thread;
              return row;
            }
            return { ...thread, pullRequests: links };
          });
          if (!changed) return [Option.none(), current];
          const next = { ...snapshot, threads };
          return [Option.some(next), { ...current, snapshot: Option.some(next) }];
        },
      );
      pendingLinkRows = new Set();
      const live = yield* Ref.get(latestLiveShell);
      if (Option.isNone(live)) return;
      const latest = Option.isSome(filled) ? { ...live.value, snapshot: filled.value } : live.value;
      yield* Ref.set(latestLiveShell, Option.some(latest));
      yield* Queue.offer(persistence, latest.snapshot);
    },
    (effect) => snapshotWriteLock.withPermit(effect),
  );
  if (Option.isSome(cached) && Option.isSome(cachedSnapshot)) {
    yield* fillDeferredPullRequests(cached.value.snapshot, cachedSnapshot.value);
  }

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamicWithAttempt(
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      Effect.fn("EnvironmentShellState.makeSubscribeInput")(function* (attempt) {
        const { session } = attempt;
        const config = yield* session.initialConfig.pipe(Effect.orElseSucceed(() => null));
        const supportsCompletionMarker = config?.shellResumeCompletionMarker === true;
        // HTTP and the socket must agree, or omitted rows would return through the socket. A new
        // snapshot flag joins this object, which also puts it in the resume key.
        const selection =
          config?.shellThreadFamilies === true ? { omitIdleSubagents: true as const } : {};
        // A resume needs the marker to know when the shell is authoritative again.
        const resumeKey =
          config?.shellResumeKey === undefined || !supportsCompletionMarker || build === undefined
            ? undefined
            : encodeResumeKey({ server: config.shellResumeKey, client: build, selection });
        // Under the write lock, so an older attempt's apply finishes before the cursor is read.
        yield* snapshotWriteLock.withPermit(
          Ref.set(activeAttempt, { attempt, resumeKey, synchronized: false }).pipe(
            Effect.andThen(Ref.set(awaitingCompletion, supportsCompletionMarker)),
          ),
        );
        yield* setSynchronizing;

        // The session that holds the shell's own snapshot resumes from its cursor. Any other
        // session, or a cached shell, resumes only when it was synchronized against the same key
        // less than a day ago; otherwise it loads the HTTP snapshot first.
        const basis = yield* Ref.get(resumeBasis);
        const age = basis === undefined ? -1 : (yield* Clock.currentTimeMillis) - basis.syncedAt;
        let canResume =
          (yield* Ref.get(lastAuthoritativeSession)) === session ||
          (resumeKey !== undefined &&
            basis?.key === resumeKey &&
            age >= 0 &&
            age < SHELL_RESUME_MAX_AGE_MS);
        let current = yield* SubscriptionRef.get(state);
        if (!canResume || Option.isNone(current.snapshot)) {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpSnapshot = yield* snapshotLoader.load(prepared, selection);
          if (Option.isSome(httpSnapshot)) {
            yield* cancelActiveFill;
            const previous = yield* SubscriptionRef.get(state);
            const snapshot = reuseUnchangedThreadShells(
              Option.getOrNull(previous.snapshot),
              withoutDeferredPullRequests(httpSnapshot.value),
            );
            const pendingLinkIds = new Set(
              httpSnapshot.value.loadPullRequests === undefined
                ? []
                : httpSnapshot.value.threads.map((thread) => thread.id),
            );
            yield* applyItems([[attempt, { kind: "snapshot", snapshot }]], pendingLinkIds);
            canResume = true;
            current = yield* SubscriptionRef.get(state);
            if (Option.isSome(current.snapshot)) {
              yield* fillDeferredPullRequests(httpSnapshot.value, current.snapshot.value);
            }
          }
        }

        const input = {
          ...selection,
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
        if (!canResume || Option.isNone(current.snapshot)) return input;
        if (!supportsCompletionMarker) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: "live" as const,
            error: Option.none(),
          }));
        }
        return { afterSequence: current.snapshot.value.snapshotSequence, ...input };
      }),
      {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEachArray((items) => applyItems(items))),
  );
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  return state;
});

function shellStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export interface EnvironmentShellSummary {
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly hasCachedShell: boolean;
  readonly hasLiveShell: boolean;
  readonly firstError: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.hasCachedShell === right.hasCachedShell &&
    left.hasLiveShell === right.hasLiveShell &&
    left.firstError === right.firstError
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let hasCachedShell = false;
    let hasLiveShell = false;
    let firstError: string | null = null;

    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      hasCachedShell ||= state.status === "cached";
      hasLiveShell ||= state.status === "live";
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
    }

    const next: EnvironmentShellSummary = {
      hasSnapshot,
      hasSynchronizingShell,
      hasCachedShell,
      hasLiveShell,
      firstError,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

/**
 * Every shell push replaces the state, so views that gate on load progress read these
 * primitives instead and stay put while threads stream.
 */
function createEnvironmentShellProgressAtoms(
  stateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>,
) {
  return {
    statusAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => get(stateValueAtom(environmentId)).status).pipe(
        Atom.withLabel(`environment-shell-status:${environmentId}`),
      ),
    ),
    hasSnapshotAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => Option.isSome(get(stateValueAtom(environmentId)).snapshot)).pipe(
        Atom.withLabel(`environment-shell-has-snapshot:${environmentId}`),
      ),
    ),
  };
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ShellSnapshotLoader.ShellSnapshotLoader
    | R,
    E
  >,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(shellStateChanges(environmentId), {
      initialValue: EMPTY_SHELL_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(environmentId))), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  const { statusAtom, hasSnapshotAtom } = createEnvironmentShellProgressAtoms(stateValueAtom);

  return {
    stateAtom,
    stateValueAtom,
    statusAtom,
    hasSnapshotAtom,
  };
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./shellPullRequests.ts";
export * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
export * from "./snapshots.ts";
