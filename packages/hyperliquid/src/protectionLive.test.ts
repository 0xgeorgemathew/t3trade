/**
 * Live testnet evidence for the §17 protective-order invariant — §17.6.
 *
 * §17.6 is explicit that documentation is not evidence: "Documentation
 * establishes intended Hyperliquid behavior; testnet evidence establishes that
 * the exact SDK and request path used by T3 implements it correctly." So this
 * file submits real orders through the real request shapes and records what
 * came back.
 *
 * Gated behind `T3_TRADES_LIVE_EXECUTION=1` plus the signer key, exactly like
 * `executionLive.test.ts`. Skipped otherwise, so an ordinary `pnpm test` never
 * spends testnet capital.
 *
 * Run with:
 *   T3_TRADES_LIVE_EXECUTION=1 \
 *   pnpm vitest run packages/hyperliquid/src/protectionLive.test.ts
 *
 * Position hygiene: every case that opens exposure closes it in the same test,
 * and the suite ends with a reduce-only close plus a cancel sweep. The size is
 * deliberately just over the $10 exchange minimum.
 *
 * @module HyperliquidProtectionLive
 */
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { HyperliquidExchangeClient, HyperliquidExchangeClientLive } from "./ExchangeClient.ts";
import { HyperliquidInfoClient, HyperliquidInfoClientLive } from "./InfoClient.ts";
import { readExchangeResponse } from "./ExchangeResponse.ts";
import { signL1ActionForWire, addressFromPrivateKey } from "./Signing.ts";
import {
  buildCancelByCloidAction,
  buildGroupedEntryWithStopAction,
  buildProtectiveStopAction,
  mapProtectiveStop,
} from "./OrderMapper.ts";
import { formatPrice, formatSize } from "./Precision.ts";
import { deriveCloid } from "./Cloid.ts";
import { confirmedProtectedSize } from "@t3tools/trading-contracts/protection";
import { interimSignerKeyPath } from "./KeyLocation.ts";

const SECRET_PATH = interimSignerKeyPath();

const loadSignerKey: Effect.Effect<Option.Option<Uint8Array>> = Effect.gen(function* () {
  const fromEnv = process.env.T3_TRADES_INTERIM_SIGNER_KEY?.trim();
  const fromFile = yield* Effect.promise(() =>
    import("node:fs/promises").then((m) => m.readFile(SECRET_PATH, "utf8")).catch(() => ""),
  );
  const raw = (fromEnv ?? fromFile).trim();
  if (!raw) return Option.none();
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (hex.length !== 64) return Option.none();
  return Option.some(Uint8Array.from(Buffer.from(hex, "hex")));
});

const isLive = process.env.T3_TRADES_LIVE_EXECUTION === "1";
const describeLive = isLive ? describe : describe.skip;

const httpWithNode = FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer));
const exchangeLayer = HyperliquidExchangeClientLive.pipe(Layer.provide(httpWithNode));
const infoLayer = HyperliquidInfoClientLive.pipe(Layer.provide(httpWithNode));
const liveLayer = Layer.mergeAll(exchangeLayer, infoLayer);

const MISSION = "mission_protect_live";
/** Just over the $10 exchange minimum at any plausible ETH price. */
const SIZE = 0.006;

/** Render a small object list for the evidence log without JSON.stringify. */
const describeOrders = (
  orders: ReadonlyArray<{
    readonly reduceOnly: boolean;
    readonly isTrigger: boolean;
    readonly remainingSize: number;
    readonly orderType?: string | undefined;
  }>,
): string =>
  orders.length === 0
    ? "none"
    : orders
        .map(
          (o) =>
            `${o.orderType ?? "?"}[size=${o.remainingSize} reduceOnly=${o.reduceOnly} trigger=${o.isTrigger}]`,
        )
        .join(", ");

/** Evidence rows, printed as a table at the end of the run. */
const evidence: Array<{ readonly evidenceCase: string; readonly observed: string }> = [];
const record = (evidenceCase: string, observed: string) =>
  Effect.sync(() => {
    evidence.push({ evidenceCase, observed });
  });

interface EthMarket {
  readonly assetIndex: number;
  readonly szDecimals: number;
  readonly markPrice: number;
}

/** Resolve ETH's live index, precision, and mark. Never hard-coded (§10.6). */
const resolveEth = Effect.gen(function* () {
  const info = yield* HyperliquidInfoClient;
  const [meta, ctxs] = yield* info.metaAndAssetCtxs;
  const assetIndex = meta.universe.findIndex((u) => u.name === "ETH");
  const universe = meta.universe[assetIndex]!;
  return {
    assetIndex,
    szDecimals: universe.szDecimals,
    markPrice: Number(ctxs[assetIndex]!.markPx),
  } satisfies EthMarket;
});

/** Sign and submit one action, returning the read-back outcome. */
const submit = (action: Record<string, unknown>, privateKey: Uint8Array) =>
  Effect.gen(function* () {
    const exchange = yield* HyperliquidExchangeClient;
    const nonce = yield* Effect.clockWith((c) => c.currentTimeMillis);
    const signature = signL1ActionForWire({ action, nonce, privateKey, isTestnet: true });
    const response = yield* exchange.submit({ action, nonce, signature });
    return readExchangeResponse(response);
  });

/** The canonical position + resting orders, as the protection path reads them. */
const readCanonical = (address: string) =>
  Effect.gen(function* () {
    const info = yield* HyperliquidInfoClient;
    const [state, orders] = yield* Effect.all([
      info.clearinghouseState(address),
      info.frontendOpenOrders(address),
    ]);
    const eth = state.assetPositions.find((p) => p.position.coin === "ETH");
    const size = eth === undefined ? 0 : Number(eth.position.szi);
    return {
      size,
      orders: orders.map((o) => ({
        market: o.coin,
        side: o.side === "B" ? ("buy" as const) : ("sell" as const),
        remainingSize: Number(o.sz),
        reduceOnly: o.reduceOnly ?? false,
        isTrigger: o.isTrigger ?? false,
        triggerPrice: Number(o.triggerPx ?? 0) || undefined,
        cloid: o.cloid ?? undefined,
        orderType: o.orderType,
      })),
    };
  });

/** A marketable IOC entry leg, priced to cross. */
const entryLeg = (market: EthMarket, side: "buy" | "sell", cloid: string) => ({
  a: market.assetIndex,
  b: side === "buy",
  p: formatPrice(market.markPrice * (side === "buy" ? 1.01 : 0.99)),
  s: formatSize(SIZE, market.szDecimals),
  r: false,
  t: { limit: { tif: "Ioc" } },
  c: cloid,
});

/** Close to flat and sweep any resting order, so a case cannot leak into the next. */
const flatten = (market: EthMarket, address: string, privateKey: Uint8Array) =>
  Effect.gen(function* () {
    const canonical = yield* readCanonical(address);

    for (const order of canonical.orders) {
      if (order.cloid === undefined) continue;
      yield* submit(buildCancelByCloidAction(market.assetIndex, order.cloid), privateKey).pipe(
        Effect.catchCause(() => Effect.void),
      );
    }

    if (Math.abs(canonical.size) < 1e-9) return;
    const closing = canonical.size > 0 ? ("sell" as const) : ("buy" as const);
    const stamp = yield* Effect.clockWith((c) => c.currentTimeMillis);
    yield* submit(
      {
        type: "order",
        orders: [
          {
            a: market.assetIndex,
            b: closing === "buy",
            p: formatPrice(market.markPrice * (closing === "buy" ? 1.02 : 0.98)),
            s: formatSize(Math.abs(canonical.size), market.szDecimals),
            r: true,
            t: { limit: { tif: "Ioc" } },
            c: deriveCloid({
              missionId: MISSION,
              strategyVersion: 0,
              executionSequence: 999,
              actionType: `flatten_${stamp}`,
            }),
          },
        ],
        grouping: "na",
      },
      privateKey,
    ).pipe(Effect.catchCause(() => Effect.void));
  });

describeLive("§17.6 protective-order testnet evidence", () => {
  it.live(
    "records the §17.6 evidence matrix against live testnet",
    () =>
      Effect.gen(function* () {
        const keyOption = yield* loadSignerKey;
        if (Option.isNone(keyOption)) {
          return yield* Effect.die("no interim signer key; cannot run live evidence");
        }
        const privateKey = keyOption.value;
        const address = addressFromPrivateKey(privateKey);
        const market = yield* resolveEth;

        yield* Effect.logInfo("[protection-live] start", {
          address,
          assetIndex: market.assetIndex,
          markPrice: market.markPrice,
          size: SIZE,
        });

        // Start from a known-clean slate.
        yield* flatten(market, address, privateKey);

        // -- Case 1 + 7: fully filled IOC with linked TP/SL, then confirm the
        // stop is live on the exchange as a reduce-only trigger.
        const entryCloid = deriveCloid({
          missionId: MISSION,
          strategyVersion: 1,
          executionSequence: 1,
          actionType: "open",
        });
        const stopPrice = market.markPrice * 0.9;
        const linkedStop = yield* mapProtectiveStop({
          cloid: deriveCloid({
            missionId: MISSION,
            strategyVersion: 1,
            executionSequence: 1,
            actionType: "open_protect",
          }),
          coin: "ETH",
          positionSize: SIZE,
          stopPrice,
          szDecimals: market.szDecimals,
        });

        const grouped = buildGroupedEntryWithStopAction(
          {
            cloid: entryCloid,
            coin: "ETH",
            side: "buy",
            limitPrice: formatPrice(market.markPrice * 1.01),
            size: formatSize(SIZE, market.szDecimals),
            timeInForce: "ioc",
            reduceOnly: false,
          },
          linkedStop,
          market.assetIndex,
        );

        const groupedOutcome = yield* submit(grouped, privateKey);
        yield* Effect.logInfo("[protection-live] grouped normalTpsl", groupedOutcome);
        yield* record(
          "Fully filled IOC with linked TP/SL",
          groupedOutcome.actionError !== undefined
            ? `action rejected: ${groupedOutcome.actionError}`
            : groupedOutcome.statuses.map((s) => s.outcome).join(" + "),
        );

        // Every per-order status is inspected, not just the first (§17.1).
        expect(groupedOutcome.statuses.length).toBeGreaterThan(0);

        // §17.2 steps 5–8: confirm protection from CANONICAL state.
        const afterEntry = yield* readCanonical(address);
        const covered = confirmedProtectedSize({
          market: "ETH",
          positionSize: afterEntry.size,
          referencePrice: market.markPrice,
          openOrders: afterEntry.orders,
        });
        yield* Effect.logInfo("[protection-live] canonical after entry", {
          size: afterEntry.size,
          covered,
          orders: afterEntry.orders,
        });
        yield* record(
          "Stop trigger placement and confirmation",
          `position ${afterEntry.size}, confirmed protected ${covered}, ` +
            `orders: ${describeOrders(afterEntry.orders)}`,
        );

        // -- Case 8: stop replacement after a scale-in. Increase, then confirm
        // the OLD fixed-size trigger did not resize itself (§17.4).
        const scaleCloid = deriveCloid({
          missionId: MISSION,
          strategyVersion: 1,
          executionSequence: 2,
          actionType: "scale_in",
        });
        yield* submit(
          { type: "order", orders: [entryLeg(market, "buy", scaleCloid)], grouping: "na" },
          privateKey,
        );
        const afterScale = yield* readCanonical(address);
        const coveredAfterScale = confirmedProtectedSize({
          market: "ETH",
          positionSize: afterScale.size,
          referencePrice: market.markPrice,
          openOrders: afterScale.orders,
        });
        yield* record(
          "Stop replacement after scale-in",
          `position grew to ${afterScale.size}; pre-existing protection covered only ` +
            `${coveredAfterScale} (a fixed-size trigger does not resize itself)`,
        );

        // Place the replacement sized to the NEW canonical position and confirm.
        const replacementCloid = deriveCloid({
          missionId: MISSION,
          strategyVersion: 1,
          executionSequence: 2,
          actionType: "protect_0",
        });
        const replacement = yield* mapProtectiveStop({
          cloid: replacementCloid,
          coin: "ETH",
          positionSize: afterScale.size,
          stopPrice,
          szDecimals: market.szDecimals,
        });
        const replacementOutcome = yield* submit(
          buildProtectiveStopAction(replacement, market.assetIndex),
          privateKey,
        );
        const afterReplacement = yield* readCanonical(address);
        const coveredAfterReplacement = confirmedProtectedSize({
          market: "ETH",
          positionSize: afterReplacement.size,
          referencePrice: market.markPrice,
          openOrders: afterReplacement.orders,
        });
        yield* record(
          "Stop replacement confirmed for the new size",
          `replacement ${replacementOutcome.statuses.map((s) => s.outcome).join(",")}; ` +
            `position ${afterReplacement.size}, confirmed protected ${coveredAfterReplacement}`,
        );

        // -- Case 6: a per-order rejection INSIDE a multi-order action. The
        // second leg carries a size of zero, which the exchange refuses while
        // the first leg is fine — the exact shape §17.1 says a 200 can hide.
        const mixedOutcome = yield* submit(
          {
            type: "order",
            orders: [
              entryLeg(
                market,
                "buy",
                deriveCloid({
                  missionId: MISSION,
                  strategyVersion: 1,
                  executionSequence: 3,
                  actionType: "mixed_ok",
                }),
              ),
              {
                ...entryLeg(
                  market,
                  "buy",
                  deriveCloid({
                    missionId: MISSION,
                    strategyVersion: 1,
                    executionSequence: 3,
                    actionType: "mixed_bad",
                  }),
                ),
                s: "0",
              },
            ],
            grouping: "na",
          },
          privateKey,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({ actionError: String(cause), statuses: [] }),
          ),
        );
        yield* record(
          "Per-order rejection inside a multi-order action",
          mixedOutcome.actionError !== undefined
            ? `action-level rejection: ${mixedOutcome.actionError}`
            : `${mixedOutcome.statuses.length} status row(s) for 2 submitted legs: ` +
                mixedOutcome.statuses
                  .map((s) => `${s.outcome}${s.reason === undefined ? "" : `(${s.reason})`}`)
                  .join(" + "),
        );

        // -- Case 5: insufficient-margin behaviour.
        //
        // Probed with a RESTING order, not a marketable one. The first attempt
        // used a 500 ETH IOC expecting a margin rejection; on a 25x market
        // with ~$98 of margin the exchange happily filled 1.0698 ETH of it
        // instead — a ~$1,990 position, 20x levered, liquidation 3% away.
        //
        // That is the finding, and it is worth more than the case it replaced:
        // the exchange does NOT protect an account from an oversized entry, it
        // fills what the margin allows. Nothing on the exchange side stands
        // between a mis-sized request and a near-liquidation position. The
        // §16.3 leverage and gross-notional checks are the only thing that
        // does, which is exactly why they run before signing rather than after.
        //
        // A resting GTC priced away from the market probes the margin check
        // without that risk: it cannot fill, so the only possible outcomes are
        // acceptance or a margin rejection.
        const oversizedOutcome = yield* submit(
          {
            type: "order",
            orders: [
              {
                a: market.assetIndex,
                b: true,
                // 30% below the market: rests, cannot cross.
                p: formatPrice(market.markPrice * 0.7),
                s: formatSize(500, market.szDecimals),
                r: false,
                t: { limit: { tif: "Gtc" } },
                c: deriveCloid({
                  missionId: MISSION,
                  strategyVersion: 1,
                  executionSequence: 4,
                  actionType: "oversized_resting",
                }),
              },
            ],
            grouping: "na",
          },
          privateKey,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({ actionError: String(cause), statuses: [] }),
          ),
        );
        yield* record(
          "Insufficient-margin behaviour",
          oversizedOutcome.actionError !== undefined
            ? `action-level: ${oversizedOutcome.actionError}`
            : oversizedOutcome.statuses
                .map((s) => `${s.outcome}${s.reason === undefined ? "" : `(${s.reason})`}`)
                .join(" + "),
        );
        yield* record(
          "Oversized marketable IOC (first run, since replaced)",
          "a 500 ETH IOC against ~$98 of margin was NOT rejected: the exchange " +
            "filled 1.0698 ETH (~$1,990 notional, ~20x, liquidation 3% away). " +
            "The exchange does not bound entry size; §16.3's leverage and " +
            "gross-notional checks are the only thing that does.",
        );

        // -- Case 3 + 4: a RESTING parent, then manual cancellation. The
        // parent is priced far from the market so it rests rather than fills,
        // which is the state a partial fill also passes through.
        const restingCloid = deriveCloid({
          missionId: MISSION,
          strategyVersion: 1,
          executionSequence: 5,
          actionType: "resting",
        });
        // Sized against the RESTING price, not the mark: a parent 30% below
        // the market only clears the $10 exchange minimum if the size is
        // computed from the price it will actually rest at. The first run used
        // the mark-sized 0.006 and was refused for notional, which evidenced
        // nothing about parent-linked behaviour.
        const restingPrice = market.markPrice * 0.7;
        const restingSize =
          Math.ceil((12 / restingPrice) * 10 ** market.szDecimals) / 10 ** market.szDecimals;
        const restingStop = yield* mapProtectiveStop({
          cloid: deriveCloid({
            missionId: MISSION,
            strategyVersion: 1,
            executionSequence: 5,
            actionType: "resting_protect",
          }),
          coin: "ETH",
          positionSize: restingSize,
          stopPrice: market.markPrice * 0.5,
          szDecimals: market.szDecimals,
        });
        const restingOutcome = yield* submit(
          buildGroupedEntryWithStopAction(
            {
              cloid: restingCloid,
              coin: "ETH",
              side: "buy",
              // 30% below the market: rests, does not cross.
              limitPrice: formatPrice(restingPrice),
              size: formatSize(restingSize, market.szDecimals),
              timeInForce: "gtc",
              reduceOnly: false,
            },
            restingStop,
            market.assetIndex,
          ),
          privateKey,
        );
        const withResting = yield* readCanonical(address);
        const restingAccepted = restingOutcome.statuses.some((s) => s.outcome === "resting");
        yield* record(
          "Resting parent with linked TP/SL (unfilled)",
          `submission: ${
            restingOutcome.actionError ??
            restingOutcome.statuses
              .map((s) => `${s.outcome}${s.reason === undefined ? "" : `(${s.reason})`}`)
              .join(" + ")
          }; resting orders now: ${describeOrders(withResting.orders)}`,
        );

        // Cancel the parent and read back what happened to its child.
        yield* submit(buildCancelByCloidAction(market.assetIndex, restingCloid), privateKey).pipe(
          Effect.catchCause(() => Effect.void),
        );
        const afterCancel = yield* readCanonical(address);
        const coveredAfterCancel = confirmedProtectedSize({
          market: "ETH",
          positionSize: afterCancel.size,
          referencePrice: market.markPrice,
          openOrders: afterCancel.orders,
        });
        yield* record(
          "Manual cancellation of a parent",
          restingAccepted
            ? `after cancelling the parent: position ${afterCancel.size}, ` +
                `confirmed protected ${coveredAfterCancel}, ` +
                `remaining orders ${describeOrders(afterCancel.orders)}`
            : "NOT EVIDENCED — the resting parent above was refused, so there was " +
                "no parent to cancel. Forcing this case needs a counterparty to " +
                "partially fill a resting order, which a single account cannot do.",
        );

        // The invariant, stated as an assertion rather than a log: whatever the
        // exchange did to the children, the open position is still covered.
        expect(coveredAfterCancel).toBeGreaterThanOrEqual(Math.abs(afterCancel.size) - 1e-9);

        // -- Leave the account flat. Also registered as a finaliser below, so
        // an assertion failure above cannot leave exposure open — the first
        // run of this file failed mid-way and left a 20x position standing.
        yield* flatten(market, address, privateKey);
        const final = yield* readCanonical(address);
        yield* record(
          "Cleanup",
          `final position ${final.size}, resting orders ${final.orders.length}`,
        );
        expect(Math.abs(final.size)).toBeLessThan(1e-9);

        // Written to disk, not just logged: §17.6 asks for recorded results,
        // and a passing run's logs are not captured by the reporter.
        const recordedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const report = [
          "# PROMPT-05 · §17.6 testnet evidence",
          "",
          `Recorded ${recordedAt} against Hyperliquid testnet.`,
          `Signer/master account: ${address}`,
          `ETH assetIndex ${market.assetIndex}, szDecimals ${market.szDecimals}, mark ${market.markPrice}`,
          `Probe size: ${SIZE} ETH`,
          "",
          "| Case | Observed |",
          "| --- | --- |",
          ...evidence.map(
            (row) => `| ${row.evidenceCase} | ${row.observed.replaceAll("|", "\\|")} |`,
          ),
          "",
        ].join("\n");

        yield* Effect.promise(async () => {
          const fs = await import("node:fs/promises");
          const path = new URL(
            "../../../artifacts/reports/prompt-05-testnet-evidence.md",
            import.meta.url,
          ).pathname;
          await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
          await fs.writeFile(path, report, "utf8");
        });

        yield* Effect.logInfo(`[protection-live] §17.6 evidence\n${report}`);
      }).pipe(
        // The finaliser is the safety net, not the happy path: whatever fails,
        // the account ends flat with nothing resting.
        Effect.ensuring(
          Effect.gen(function* () {
            const keyOption = yield* loadSignerKey;
            if (Option.isNone(keyOption)) return;
            const market = yield* resolveEth;
            yield* flatten(market, addressFromPrivateKey(keyOption.value), keyOption.value);
          }).pipe(Effect.catchCause(() => Effect.void)),
        ),
        Effect.provide(liveLayer),
      ),
    180_000,
  );
});
