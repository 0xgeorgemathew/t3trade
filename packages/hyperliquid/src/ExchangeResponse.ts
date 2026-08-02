/**
 * Reading every per-order status out of an `/exchange` response - spec §17.2
 * step 4, §17.1.
 *
 * §17.1 is blunt about this: never treat a batch as atomic. A grouped
 * `normalTpsl` request that returns HTTP 200 can still contain a rejected
 * child, an untriggered child, or a child the exchange dropped. The only way
 * to know is to read each row, so this module exists to make that reading
 * total and testable rather than a set of optional-chained guesses at a call
 * site.
 *
 * Two shapes have to survive here.
 *
 * The response envelope nests the rows under `response.data.statuses`, not
 * `response.statuses`. Reading only the shallow path yields an empty list on
 * every real order response, and "no statuses" is indistinguishable from "no
 * orders accepted" — a silent way to believe an entry never landed while it is
 * filling. Both paths are read.
 *
 * The rows themselves are a mix. Some are bare strings ("success",
 * "waitingForFill", "waitingForTrigger"); the rest are single-key objects
 * naming the outcome: `{resting: {oid, cloid}}`, `{filled: {totalSz, avgPx,
 * oid, cloid}}`, `{error: "..."}`. Anything unrecognised is reported as an
 * error rather than skipped — an unreadable status is not a passing one.
 *
 * @module HyperliquidExchangeResponse
 */

/** The outcome of one order in a (possibly grouped) submission. */
export type OrderStatusOutcome =
  | "filled"
  | "resting"
  | "waiting_for_fill"
  | "waiting_for_trigger"
  | "success"
  | "error";

/** One per-order row, normalised. */
export interface OrderStatusRow {
  readonly outcome: OrderStatusOutcome;
  /** Client order id, when the exchange echoed one back. */
  readonly cloid: string | undefined;
  /** Exchange-assigned order id, when the order exists. */
  readonly orderId: number | undefined;
  /** Executed size, on a `filled` row. */
  readonly filledSize: number | undefined;
  /** Average fill price, on a `filled` row. */
  readonly averagePrice: number | undefined;
  /** Error text, on an `error` row. */
  readonly reason: string | undefined;
}

/** What one `/exchange` response says about the action and its orders. */
export interface ExchangeActionOutcome {
  /**
   * Action-level failure text. The exchange reports these as
   * `{status: "err", response: "<text>"}` with no per-order rows at all — an
   * insufficient-margin rejection arrives this way.
   */
  readonly actionError: string | undefined;
  readonly statuses: ReadonlyArray<OrderStatusRow>;
}

const EMPTY_ROW = {
  cloid: undefined,
  orderId: undefined,
  filledSize: undefined,
  averagePrice: undefined,
  reason: undefined,
} as const;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Normalise a bare-string status row. */
function readStringRow(value: string): OrderStatusRow {
  switch (value) {
    case "success":
      return { ...EMPTY_ROW, outcome: "success" };
    case "waitingForFill":
      return { ...EMPTY_ROW, outcome: "waiting_for_fill" };
    case "waitingForTrigger":
      // A parent-linked child sits here while its parent is unfilled or
      // partially filled. §17.1: this is NOT live protection.
      return { ...EMPTY_ROW, outcome: "waiting_for_trigger" };
    default:
      return { ...EMPTY_ROW, outcome: "error", reason: value };
  }
}

/** Normalise a single-key object status row. */
function readObjectRow(row: Record<string, unknown>): OrderStatusRow {
  const error = asString(row.error);
  if (error !== undefined) {
    return { ...EMPTY_ROW, outcome: "error", reason: error };
  }

  const resting = asRecord(row.resting);
  if (resting !== undefined) {
    return {
      ...EMPTY_ROW,
      outcome: "resting",
      cloid: asString(resting.cloid),
      orderId: asNumber(resting.oid),
    };
  }

  const filled = asRecord(row.filled);
  if (filled !== undefined) {
    return {
      ...EMPTY_ROW,
      outcome: "filled",
      cloid: asString(filled.cloid),
      orderId: asNumber(filled.oid),
      filledSize: asNumber(filled.totalSz),
      averagePrice: asNumber(filled.avgPx),
    };
  }

  // An unrecognised row is an error, not a pass. Treating it as success is
  // how an unprotected position gets marked protected.
  return {
    ...EMPTY_ROW,
    outcome: "error",
    reason: `unrecognised order status: ${JSON.stringify(row)}`,
  };
}

/**
 * Read an `/exchange` response into an action-level verdict plus one row per
 * submitted order.
 *
 * Accepts `unknown` deliberately: the wire schema is permissive so a shape
 * drift cannot fail the decode before this function gets to look at it. A
 * response this cannot read produces an `actionError`, never a silent empty
 * success.
 */
export function readExchangeResponse(value: unknown): ExchangeActionOutcome {
  const envelope = asRecord(value);
  if (envelope === undefined) {
    return { actionError: "exchange response was not an object", statuses: [] };
  }

  // `{status: "err", response: "<text>"}` — an action-level rejection with no
  // per-order rows (insufficient margin arrives this way).
  const responseText = asString(envelope.response);
  if (responseText !== undefined) {
    return { actionError: responseText, statuses: [] };
  }

  const response = asRecord(envelope.response);
  if (response === undefined) {
    return { actionError: "exchange response carried no `response`", statuses: [] };
  }

  // The rows live under `response.data.statuses`. The shallow
  // `response.statuses` is read too, so a fake or a future shape that flattens
  // it still works.
  const data = asRecord(response.data);
  const rawStatuses = data?.statuses ?? response.statuses;

  if (!Array.isArray(rawStatuses)) {
    // No rows at all. For a noop (`type: "default"`) that is expected; for an
    // order it means the response could not be read, which must surface.
    const type = asString(response.type);
    return type === "default" || type === "cancel"
      ? { actionError: undefined, statuses: [] }
      : {
          actionError: `exchange response of type ${type ?? "unknown"} carried no per-order statuses`,
          statuses: [],
        };
  }

  const statuses = rawStatuses.map((row) => {
    const text = asString(row);
    if (text !== undefined) return readStringRow(text);
    const record = asRecord(row);
    return record === undefined
      ? { ...EMPTY_ROW, outcome: "error" as const, reason: `unreadable status row: ${String(row)}` }
      : readObjectRow(record);
  });

  return { actionError: undefined, statuses };
}

/**
 * The response variant the exchange echoed ("order", "default", "cancel", …),
 * or undefined when the response carried no readable type. Reading this off
 * the permissive envelope belongs here rather than at each call site.
 */
export function exchangeResponseType(value: unknown): string | undefined {
  const response = asRecord(asRecord(value)?.response);
  return response === undefined ? undefined : asString(response.type);
}

/**
 * True when this row means the order exists on the exchange — filled or
 * resting. Everything else (waiting, error) does not.
 *
 * `waiting_for_trigger` is deliberately excluded. A parent-linked stop in that
 * state is the exact case §17.1 warns about: present in the response, not live
 * protection.
 */
export function isLiveOnExchange(row: OrderStatusRow): boolean {
  return row.outcome === "filled" || row.outcome === "resting";
}
