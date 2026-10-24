import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * Which threads have an agent execution running, so the server browser can keep an
 * agent's tab focused between its tool calls instead of blurring it after each one.
 */
export class PreviewAgentActivity extends Context.Service<
  PreviewAgentActivity,
  {
    /** Marks the thread as executing until the returned effect runs; it runs at most once. */
    readonly begin: (threadId: ThreadId) => Effect.Effect<Effect.Effect<void>>;
    /**
     * Completes once no execution runs on the thread; None when none runs now. Overlapping
     * executions share one instance, so callers can tell whether they hold the current one.
     */
    readonly running: (threadId: ThreadId) => Effect.Effect<Option.Option<Effect.Effect<void>>>;
  }
>()("t3/preview/PreviewAgentActivity") {}

interface ThreadActivity {
  readonly executions: Set<symbol>;
  readonly ended: Deferred.Deferred<void>;
  readonly awaitEnded: Effect.Effect<void>;
}

const make = Effect.sync(() => {
  const threads = new Map<ThreadId, ThreadActivity>();

  const begin = Effect.fn("PreviewAgentActivity.begin")(function* (threadId: ThreadId) {
    let activity = threads.get(threadId);
    if (activity === undefined) {
      const ended = yield* Deferred.make<void>();
      activity = { executions: new Set(), ended, awaitEnded: Deferred.await(ended) };
      threads.set(threadId, activity);
    }
    // A token per execution, so an older execution ending never ends a newer one.
    const execution = Symbol(threadId);
    activity.executions.add(execution);
    const current = activity;
    return Effect.suspend(() => {
      if (!current.executions.delete(execution) || current.executions.size > 0) {
        return Effect.void;
      }
      if (threads.get(threadId) === current) threads.delete(threadId);
      return Deferred.succeed(current.ended, undefined).pipe(Effect.asVoid);
    });
  });

  const running = (threadId: ThreadId) =>
    Effect.sync(() => Option.map(Option.fromNullishOr(threads.get(threadId)), (a) => a.awaitEnded));

  return PreviewAgentActivity.of({ begin, running });
});

export const layer = Layer.effect(PreviewAgentActivity, make);
