/**
 * Hyperliquid precision normalisation.
 *
 * Pure, deterministic math — no Effect service, no I/O. The exchange enforces
 * two independent precision contracts that this module encodes:
 *
 *  - **Size** is truncated to the market's `szDecimals` (Hyperliquid truncates,
 *    never rounds, so a size of 0.30001 with szDecimals=4 becomes 0.3, not
 *    0.3000 + carry). Trailing zeros are stripped because the exchange rejects
 *    "0.3000" — only the canonical short form "0.3" is accepted.
 *  - **Price** is rounded to 5 significant figures (Hyperliquid uses
 *    `nSigFigs: 5` on its `l2Book`/`candle` requests). `toPrecision(5)` is
 *    unsuitable here because it falls back to exponential notation for small
 *    numbers (`"0.0001235e-4"`), so the rounding is computed explicitly with
 *    logarithms.
 *
 * Trailing-zero stripping is shared by both paths: Hyperliquid rejects
 * `"3750.00"`, `"3750.10"`, and `"0.3000"` outright — only the canonical
 * short forms (`"3750"`, `"3750.1"`, `"0.3"`) are accepted.
 *
 * @module HyperliquidPrecision
 */

/**
 * Minimum order notional (size * price) accepted by the Hyperliquid testnet
 * during the T3 Trade POC. Live mainnet minimums vary per market and are
 * sourced from metadata in production code; this constant is the POC floor.
 */
export const MIN_NOTIONAL_USD = 10;

/**
 * Round `value` to `sigFigs` significant figures.
 *
 * Default is 5 — Hyperliquid's price-encoding width on its read endpoints.
 * Implemented explicitly (not via `Number.prototype.toPrecision`) because
 * `toPrecision` switches to exponential notation for small magnitudes
 * (`(0.000123456).toPrecision(5) === "0.00012346"` is fine, but edge inputs
 * near `1e-6` and below come back as `"1.2345e-6"` and break string consumers).
 *
 * - `NaN` throws; `Infinity`/`-Infinity` throw.
 * - `0` returns `0` (no significant figures to preserve, and `log10(0)` is
 *   undefined).
 * - Negative numbers round symmetrically: `roundToSignificantFigures(-3750.123, 5)`
 *   → `-3750.1`.
 *
 * The algorithm: find the order of magnitude `m = floor(log10(|value|))`,
 * then `10^(m - sigFigs + 1)` is the quantum. Round to the nearest quantum.
 */
export function roundToSignificantFigures(value: number, sigFigs = 5): number {
  if (Number.isNaN(value)) {
    throw new RangeError("roundToSignificantFigures: value is NaN");
  }
  if (!Number.isFinite(value)) {
    throw new RangeError(`roundToSignificantFigures: value must be finite, got ${value}`);
  }
  if (sigFigs <= 0 || !Number.isInteger(sigFigs)) {
    throw new RangeError(
      `roundToSignificantFigures: sigFigs must be a positive integer, got ${sigFigs}`,
    );
  }
  if (value === 0) return 0;

  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const magnitude = Math.floor(Math.log10(abs));
  // Quantum between adjacent representable values at this many sig figs.
  const quantum = Math.pow(10, magnitude - sigFigs + 1);
  // Math.round on a negative number is correctly directed only after we strip
  // the sign — round the magnitude, then re-apply.
  const rounded = Math.round(abs / quantum) * quantum;
  return sign * rounded;
}

/**
 * Strip trailing zeros from a numeric string's fractional part, and the
 * trailing decimal point if no fraction remains. `"3750.00"` → `"3750"`,
 * `"3750.10"` → `"3750.1"`, `"3750"` → `"3750"`.
 *
 * Pure string surgery — no number coercion, so the input's precision is
 * preserved (important after `toFixed`, which can produce values like
 * `"0.3000"`).
 */
function stripTrailingZeros(value: string): string {
  if (value.includes(".")) {
    // Strip trailing zeros, then a dangling decimal point.
    const trimmed = value.replace(/0+$/, "");
    return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  }
  return value;
}

/**
 * Format a price as the canonical short string Hyperliquid expects: 5
 * significant figures (rounded, not truncated — Hyperliquid's `nSigFigs: 5`
 * applies rounding), trailing zeros stripped, no exponential notation.
 *
 * Examples:
 *   - `3750.0` → `"3750"`
 *   - `3750.10` → `"3750.1"`
 *   - `123.456789` → `"123.46"` (5 sig figs)
 *   - `0.0001235` → `"0.0001235"` (already 4 sig figs — no change)
 *   - `0.000123456` → `"0.00012346"` (5 sig figs from the rounding step)
 *
 * We avoid `Number.prototype.toPrecision` because it falls back to exponential
 * notation for small magnitudes. The pipeline is: round to 5 sig figs via
 * {@link roundToSignificantFigures}, then emit through `toFixed(d)` where `d`
 * is the number of fractional digits implied by the magnitude (`d` is clamped
 * to be non-negative so integer-magnitude prices emit `toFixed(0)`). The
 * `toFixed` step matters because the rounded float can carry representation
 * error (e.g. `3750.1000000000004`) — `toFixed(d)` projects that back to the
 * intended decimal places, then {@link stripTrailingZeros} produces the
 * canonical short form.
 */
export function formatPrice(price: number): string {
  if (Number.isNaN(price)) {
    throw new RangeError("formatPrice: price is NaN");
  }
  if (!Number.isFinite(price)) {
    throw new RangeError(`formatPrice: price must be finite, got ${price}`);
  }
  const rounded = roundToSignificantFigures(price, 5);
  if (rounded === 0) return "0";

  const sign = rounded < 0 ? -1 : 1;
  const abs = Math.abs(rounded);
  // The magnitude of the most-significant digit. For abs < 1 this is negative
  // (e.g. 0.0001235 has magnitude -4). The number of fractional digits needed
  // to express 5 sig figs at this magnitude is `sigFigs - 1 - magnitude`.
  const magnitude = Math.floor(Math.log10(abs));
  const fractionalDigits = Math.max(0, 5 - 1 - magnitude);
  // Materialise at the implied width (toFixed also absorbs the float-repr
  // error like 3750.1000000000004 → "3750.1"), prepend the sign if negative,
  // then strip trailing zeros. toFixed(N) on abs >= 0 never emits "-0".
  const fixed = abs.toFixed(fractionalDigits);
  return stripTrailingZeros(sign === -1 ? `-${fixed}` : fixed);
}

/**
 * Format a size to the market's `szDecimals`, truncating (not rounding) and
 * stripping trailing zeros. Hyperliquid truncates size — a size of 0.30001 at
 * szDecimals=4 must become 0.3, not 0.3000 with a carry-up.
 *
 * Examples:
 *   - `(0.3, 4)` → `"0.3"` (trailing zeros stripped)
 *   - `(0.30001, 4)` → `"0.3"` (truncated, not rounded to 0.3000)
 *   - `(1.5, 2)` → `"1.5"`
 *   - `(0, 4)` → `"0"`
 *
 * Truncation is implemented by shifting down to an integer rather than using
 * `toFixed(szDecimals)` (which rounds half-up): `Math.floor(size * 10^d) / 10^d`
 * gives a strict truncation, then `toFixed(d)` materialises the fixed-width
 * form that {@link stripTrailingZeros} shortens.
 */
export function formatSize(size: number, szDecimals: number): string {
  if (Number.isNaN(size)) {
    throw new RangeError("formatSize: size is NaN");
  }
  if (!Number.isFinite(size)) {
    throw new RangeError(`formatSize: size must be finite, got ${size}`);
  }
  if (szDecimals < 0 || !Number.isInteger(szDecimals)) {
    throw new RangeError(
      `formatSize: szDecimals must be a non-negative integer, got ${szDecimals}`,
    );
  }
  if (size === 0) return "0";

  const sign = size < 0 ? -1 : 1;
  const abs = Math.abs(size);
  const shift = Math.pow(10, szDecimals);
  // Truncate (not round) to szDecimals: floor toward zero.
  const truncated = (sign * Math.floor(abs * shift)) / shift;
  if (truncated === 0) return "0";
  return stripTrailingZeros(truncated.toFixed(szDecimals));
}

/**
 * True iff the order's notional (`size * price`) is at least `minNotional`.
 *
 * The Hyperliquid testnet rejects orders below the exchange minimum notional
 * (POC floor: {@link MIN_NOTIONAL_USD}). `NaN` inputs short-circuit to `false`
 * — a NaN notional is not a valid order, and reporting it as below-minimum is
 * the safe failure mode.
 *
 * Examples (with `minNotional` defaulting to 10):
 *   - `(0.3, 3750)` → `true` (notional 1125)
 *   - `(0.001, 3750)` → `false` (notional 3.75)
 *   - `(0.3, 3750, 2000)` → `false` (notional 1125 < 2000)
 */
export function meetsMinimumNotional(
  size: number,
  price: number,
  minNotional: number = MIN_NOTIONAL_USD,
): boolean {
  const notional = size * price;
  if (Number.isNaN(notional)) return false;
  return notional >= minNotional;
}
