import { type EnvironmentId } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  onNewThreadInProject: () => void;
  /** Rendered after the thread title, before the actions. Trading's mission pill. */
  readonly missionSlot?: ReactNode;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  missionSlot,
  onNewThreadInProject,
}: ChatHeaderProps) {
  return (
    // Three regions, not two: the mission pill sits in a centre column of its
    // own so it reads as a peer of the thread title rather than as something
    // trailing it. The column collapses to nothing when no mission is bound, so
    // a non-trading thread's layout is unchanged.
    <div
      className={cn(
        "@container/header-actions grid min-w-0 flex-1 items-center gap-2 sm:gap-3",
        missionSlot ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" : "grid-cols-1",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 overflow-hidden sm:gap-3">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <span className="inline-flex shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`New thread in ${activeProjectName}`}
                    onClick={onNewThreadInProject}
                    className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <ProjectFavicon
                  environmentId={activeThreadEnvironmentId}
                  cwd={activeProjectCwd ?? ""}
                  className="size-3.5"
                />
                <span className="max-w-40 truncate text-sm font-medium">{activeProjectName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
            </Tooltip>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
      {missionSlot ? (
        <>
          <div className="flex min-w-0 justify-self-center">{missionSlot}</div>
          {/* Empty balancing column so the centre column stays centred. */}
          <div aria-hidden />
        </>
      ) : null}
    </div>
  );
});
