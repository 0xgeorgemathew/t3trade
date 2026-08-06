/**
 * Who may read a market chart.
 *
 * The chart RPC must not become a free Hyperliquid proxy, so it serves only
 * markets the caller holds — or held — a mission on. The environment is the
 * trust boundary (the mission snapshot RPC does not bind to
 * `currentSession.subject` either), so this checks the market and the mission's
 * status and nothing more.
 *
 * Extracted from the `ws.ts` handler because the rule has two shapes and both
 * need pinning: the live chart requires a mission that is currently running,
 * while the post-mortem chart on a finished mission's card is windowed and its
 * mission is terminal by definition. Refusing a terminal mission on the
 * windowed path would refuse every review chart there is.
 *
 * @module chartReadEntitlement
 */

/** The two statuses §11.1 calls permanent terminals. */
const TERMINAL_STATUSES = new Set(["revoked", "completed"]);

export interface ChartReadRequest {
  readonly market: string;
  /** Present on both bounds means a windowed (post-mortem) read. */
  readonly startTime?: number | undefined;
  readonly endTime?: number | undefined;
}

export interface ChartReadMission {
  readonly market: string;
  readonly status: string;
}

/** True when a windowed read was asked for: both bounds present. */
export function isReviewRead(request: ChartReadRequest): boolean {
  return request.startTime !== undefined && request.endTime !== undefined;
}

/**
 * Whether any of `missions` entitles this read.
 *
 * A review read is entitled by any mission on the market, terminal included; a
 * live read needs one that is still running.
 */
export function isChartReadEntitled(
  request: ChartReadRequest,
  missions: ReadonlyArray<ChartReadMission>,
): boolean {
  const review = isReviewRead(request);
  return missions.some((mission) => {
    if (mission.market !== request.market) return false;
    return review || !TERMINAL_STATUSES.has(mission.status);
  });
}
