/**
 * Reading per-order statuses out of an `/exchange` response (§17.2 step 4).
 *
 * The payloads below are the shapes the exchange actually sends. The nesting
 * under `response.data.statuses` is the load-bearing one: reading only the
 * shallow path returns an empty list for every real order response, and an
 * empty list is indistinguishable from "nothing was accepted".
 */
import { describe, expect, it } from "@effect/vitest";

import {
  exchangeResponseType,
  isLiveOnExchange,
  readExchangeResponse,
} from "./ExchangeResponse.ts";

const orderResponse = (statuses: ReadonlyArray<unknown>) => ({
  status: "ok",
  response: { type: "order", data: { statuses } },
});

describe("readExchangeResponse", () => {
  it("reads statuses nested under response.data", () => {
    const outcome = readExchangeResponse(
      orderResponse([{ filled: { totalSz: "0.01", avgPx: "3000.5", oid: 77, cloid: "0xabc" } }]),
    );

    expect(outcome.actionError).toBeUndefined();
    expect(outcome.statuses).toHaveLength(1);
    expect(outcome.statuses[0]).toMatchObject({
      outcome: "filled",
      orderId: 77,
      cloid: "0xabc",
      filledSize: 0.01,
      averagePrice: 3_000.5,
    });
  });

  it("still reads a flattened response.statuses", () => {
    const outcome = readExchangeResponse({
      status: "ok",
      response: { type: "order", statuses: [{ resting: { oid: 12 } }] },
    });
    expect(outcome.statuses[0]?.outcome).toBe("resting");
    expect(outcome.statuses[0]?.orderId).toBe(12);
  });

  it("reads every row of a grouped submission, not just the first", () => {
    // §17.1: never treat a batch as atomic. A 200 with a live parent and a
    // rejected child is the case this exists to catch.
    const outcome = readExchangeResponse(
      orderResponse([
        { filled: { totalSz: "0.01", avgPx: "3000.0", oid: 1 } },
        { error: "Order has invalid size" },
      ]),
    );

    expect(outcome.statuses).toHaveLength(2);
    expect(outcome.statuses[0]?.outcome).toBe("filled");
    expect(outcome.statuses[1]?.outcome).toBe("error");
    expect(outcome.statuses[1]?.reason).toContain("invalid size");
  });

  it("reads a parent-linked child that is only waiting for its trigger", () => {
    // Present in the response, NOT live protection (§17.1).
    const outcome = readExchangeResponse(
      orderResponse([{ resting: { oid: 1 } }, "waitingForTrigger"]),
    );

    expect(outcome.statuses[1]?.outcome).toBe("waiting_for_trigger");
    expect(isLiveOnExchange(outcome.statuses[1]!)).toBe(false);
  });

  it("reads waitingForFill and success rows", () => {
    const outcome = readExchangeResponse(orderResponse(["waitingForFill", "success"]));
    expect(outcome.statuses.map((s) => s.outcome)).toEqual(["waiting_for_fill", "success"]);
  });

  it("surfaces an action-level rejection carried as a bare string", () => {
    // Insufficient margin arrives this way: no per-order rows at all.
    const outcome = readExchangeResponse({
      status: "err",
      response: "Insufficient margin to place order.",
    });

    expect(outcome.actionError).toBe("Insufficient margin to place order.");
    expect(outcome.statuses).toEqual([]);
  });

  it("reports an order response with no statuses as an action error", () => {
    // "No rows" must never read as "accepted".
    const outcome = readExchangeResponse({ status: "ok", response: { type: "order" } });
    expect(outcome.actionError).toContain("no per-order statuses");
  });

  it("accepts a noop, which legitimately carries no statuses", () => {
    const outcome = readExchangeResponse({ status: "ok", response: { type: "default" } });
    expect(outcome.actionError).toBeUndefined();
    expect(outcome.statuses).toEqual([]);
  });

  it("reports an unrecognised row as an error rather than skipping it", () => {
    const outcome = readExchangeResponse(orderResponse([{ somethingNew: { oid: 1 } }]));
    expect(outcome.statuses[0]?.outcome).toBe("error");
    expect(outcome.statuses[0]?.reason).toContain("unrecognised order status");
  });

  it("reports a non-object response rather than throwing", () => {
    expect(readExchangeResponse(null).actionError).toContain("not an object");
    expect(readExchangeResponse({ status: "ok" }).actionError).toContain("no `response`");
  });
});

describe("isLiveOnExchange", () => {
  it("counts filled and resting as live, and nothing else", () => {
    const outcome = readExchangeResponse(
      orderResponse([
        { filled: { totalSz: "0.01", avgPx: "3000.0", oid: 1 } },
        { resting: { oid: 2 } },
        "waitingForTrigger",
        { error: "nope" },
      ]),
    );
    expect(outcome.statuses.map(isLiveOnExchange)).toEqual([true, true, false, false]);
  });
});

describe("exchangeResponseType", () => {
  it("echoes the response variant", () => {
    expect(exchangeResponseType(orderResponse([]))).toBe("order");
    expect(exchangeResponseType({ status: "ok", response: { type: "default" } })).toBe("default");
    expect(exchangeResponseType({ status: "err", response: "nope" })).toBeUndefined();
  });
});
