/**
 * The stale-data banner, wherever a position is shown.
 *
 * It used to live only in the workspace panel, which is the surface an operator
 * is least likely to be looking at while a position is open — the thread is.
 * One component, two mounts, so the two cannot end up telling different stories
 * about whether the position read is current.
 *
 * @module MissionStalenessBanner
 */
import type { TradingMissionStatus } from "@t3tools/trading-contracts";

import { cn } from "~/lib/utils";
import { describeStaleness } from "./tradingPresentation";

export interface StalenessSubject {
  readonly status: TradingMissionStatus;
  readonly position: { readonly size: number; readonly observedAt: string } | null;
}

/**
 * Renders nothing while the read is fresh.
 *
 * `Date.now()` is read on each render rather than on a timer: the projection
 * poll is what moves this, and a second timer would only let the banner
 * disagree with the data it is describing.
 */
export function MissionStalenessBanner({
  mission,
  className,
}: {
  mission: StalenessSubject;
  className?: string;
}) {
  const message = describeStaleness(mission, Date.now());
  if (message === null) return null;

  return (
    <div
      className={cn(
        "border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground sm:px-4",
        className,
      )}
      data-testid="stale-data-banner"
    >
      {message}
    </div>
  );
}

/**
 * The projection poll failed.
 *
 * A failed poll and a frozen position look identical from the outside, and the
 * workspace panel was the only surface that said which one it was. A thread
 * holding exposure needs the same warning: nothing on screen is being refreshed.
 */
export function MissionFeedErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground sm:px-4"
      data-testid="mission-feed-error"
    >
      {message} Nothing on this thread is refreshing.
    </div>
  );
}
