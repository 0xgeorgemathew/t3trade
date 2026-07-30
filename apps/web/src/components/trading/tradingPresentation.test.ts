import { describe, expect, it } from "vite-plus/test";

import {
  describeWatch,
  formatUsd,
  humanizeLiteral,
  MISSION_STATUS_LABELS,
} from "./tradingPresentation";

describe("mission status labels", () => {
  it("names all ten §11.1 statuses", () => {
    expect(Object.keys(MISSION_STATUS_LABELS).sort()).toEqual([
      "agent_unavailable",
      "analysing",
      "blocked",
      "completed",
      "executing",
      "initializing",
      "paused",
      "position_open",
      "revoked",
      "waiting",
    ]);
  });
});

describe("describeWatch", () => {
  it("reads each watch predicate back without interpreting it", () => {
    expect(
      describeWatch({
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "above",
        price: 3200,
      }),
    ).toBe("ETH mark crosses above 3200");

    expect(
      describeWatch({
        type: "candle_close",
        market: "ETH",
        interval: "5m",
        direction: "below",
        price: 3100,
      }),
    ).toBe("ETH 5m candle closes below 3100");

    expect(describeWatch({ type: "order_update", cloid: "cloid-1" })).toBe("Order cloid-1 updates");
    expect(describeWatch({ type: "position_update", market: "ETH" })).toBe("ETH position updates");
    expect(describeWatch({ type: "scheduled_reassessment", runAt: 0 })).toBe(
      "Scheduled reassessment at 1970-01-01T00:00:00.000Z",
    );
  });
});

describe("value formatting", () => {
  it("renders whole-dollar mandate amounts", () => {
    expect(formatUsd(3000)).toBe("$3,000");
  });

  it("turns domain literals into prose", () => {
    expect(humanizeLiteral("breakout_continuation")).toBe("breakout continuation");
    expect(humanizeLiteral("protection_failure")).toBe("protection failure");
  });
});
