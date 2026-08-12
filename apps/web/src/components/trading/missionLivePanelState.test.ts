// Which surface the pinned panel draws, and whether that surface puts the
// candle poll on the wire.
//
// The failure these pin down: a mission that had completed four turns — with a
// market, a live mark, armed reassessments and a run history — rendered one
// line of text saying it was analysing, because the chart was gated on a
// published strategy. Everything the chart draws is derivable without one.
import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationTradingMission } from "@t3tools/contracts";

import { panelWantsChart, readPanelState } from "./MissionLivePanel";

/** The two fields the state derivation actually reads, as the projection has them. */
const mission = (fields: {
  readonly status: string;
  readonly strategy: unknown;
  readonly position?: { readonly size: number } | null;
}): OrchestrationTradingMission =>
  ({
    status: fields.status,
    strategy: fields.strategy,
    position: fields.position ?? null,
  }) as unknown as OrchestrationTradingMission;

describe("readPanelState", () => {
  it("calls an operative mission with no strategy planning", () => {
    expect(readPanelState(mission({ status: "analysing", strategy: null }))).toBe("planning");
  });

  it("calls a published, flat mission armed", () => {
    expect(readPanelState(mission({ status: "waiting", strategy: {} }))).toBe("armed");
  });

  it("calls an exposed mission live, whatever the strategy says", () => {
    expect(
      readPanelState(mission({ status: "position_open", strategy: {}, position: { size: 0.05 } })),
    ).toBe("live");
  });

  it("ignores a closed position's leftover snapshot row", () => {
    // Closing zeroes the size rather than deleting the row.
    expect(
      readPanelState(mission({ status: "waiting", strategy: {}, position: { size: 0 } })),
    ).toBe("armed");
  });

  it("calls a finished mission complete before anything else", () => {
    expect(
      readPanelState(mission({ status: "completed", strategy: {}, position: { size: 0.05 } })),
    ).toBe("complete");
  });
});

describe("panelWantsChart", () => {
  it("draws candles while planning — the market and interval are known at creation", () => {
    expect(panelWantsChart("planning")).toBe(true);
  });

  it("draws candles while armed and live", () => {
    expect(panelWantsChart("armed")).toBe(true);
    expect(panelWantsChart("live")).toBe(true);
  });

  it("leaves the finished mission's chart to the timeline's summary card", () => {
    expect(panelWantsChart("complete")).toBe(false);
  });
});
