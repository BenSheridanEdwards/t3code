import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  decisionInboxThreads,
  threadDecisionReasons,
} from "@t3tools/client-runtime/state/thread-inbox";
import { useEnvironments } from "../../state/environments";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

export function DecisionInbox() {
  const [open, setOpen] = useState(false);
  const threads = useQuietThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const decisions = decisionInboxThreads(threads);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="mt-2">
        <DialogTrigger render={<Button variant="ghost" size="sm" />}>
          Needs your decision ({decisions.length})
        </DialogTrigger>
      </div>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Needs your decision</DialogTitle>
          <DialogDescription>
            Across all projects. Open a thread to review its context and respond. Opening it keeps
            the decision pending until you answer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {decisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No outstanding decisions.</p>
          ) : (
            <ul className="space-y-2">
              {decisions.map((thread) => {
                const project = projects.find(
                  (candidate) =>
                    candidate.environmentId === thread.environmentId &&
                    candidate.id === thread.projectId,
                );
                const environment = environments.find(
                  (entry) => entry.environmentId === thread.environmentId,
                );
                return (
                  <li key={`${thread.environmentId}:${thread.id}`}>
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId: thread.environmentId, threadId: thread.id }}
                      onClick={() => setOpen(false)}
                      className="block rounded-lg border p-3 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <div className="text-sm font-medium">{thread.title}</div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {threadDecisionReasons(thread).join(" · ")}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {project?.title ?? "Project"} · {environment?.label ?? "Environment"}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
