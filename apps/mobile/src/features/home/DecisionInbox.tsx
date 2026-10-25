import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  decisionInboxThreads,
  threadDecisionReasons,
} from "@t3tools/client-runtime/state/thread-inbox";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import { AppText } from "../../components/ui/AppText";

export function DecisionInbox({
  threads,
  projects,
  environments,
  onSelectThread,
}: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly projects: readonly EnvironmentProject[];
  readonly environments: readonly HomeListFilterMenuEnvironment[];
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const decisions = decisionInboxThreads(threads);
  return (
    <View className="px-4 py-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-12 justify-center"
      >
        <AppText className="font-t3-medium text-primary-text">
          Needs your decision ({decisions.length}) {expanded ? "−" : "+"}
        </AppText>
      </Pressable>
      {expanded ? (
        <View className="gap-2">
          <AppText className="text-sm text-foreground-muted">
            Across all projects. Open a thread to review its context and respond.
          </AppText>
          <ScrollView className="max-h-72" nestedScrollEnabled>
            {decisions.length === 0 ? (
              <AppText className="py-2 text-sm text-foreground-muted">
                No outstanding decisions.
              </AppText>
            ) : (
              decisions.map((thread) => {
                const project = projects.find(
                  (candidate) =>
                    candidate.environmentId === thread.environmentId &&
                    candidate.id === thread.projectId,
                );
                const environment = environments.find(
                  (entry) => entry.environmentId === thread.environmentId,
                );
                return (
                  <Pressable
                    key={`${thread.environmentId}:${thread.id}`}
                    accessibilityRole="button"
                    onPress={() => onSelectThread(thread)}
                    className="gap-1 rounded-xl bg-secondary p-3 my-1"
                  >
                    <AppText className="font-t3-medium">{thread.title}</AppText>
                    <AppText className="text-sm text-foreground-muted">
                      {threadDecisionReasons(thread).join(" · ")}
                    </AppText>
                    <AppText className="text-xs text-foreground-muted">
                      {project?.title ?? "Project"} · {environment?.label ?? "Environment"}
                    </AppText>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
