import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  SETTLED_RECEIPT_RETENTION_MILLIS,
  TradingExecutionReceipts,
  TradingExecutionReceiptsLive,
} from "./TradingExecutionReceipts.ts";

const layer = it.layer(TradingExecutionReceiptsLive);

layer("TradingExecutionReceipts", (it) => {
  it.effect("retains an early settle for a late waiter", () =>
    Effect.gen(function* () {
      const receipts = yield* TradingExecutionReceipts;
      yield* receipts.settle({ missionId: "mission_1", executionSequence: 1 });
      const signalled = yield* receipts.awaitSettled({
        missionId: "mission_1",
        executionSequence: 1,
        timeoutMillis: 1,
      });
      assert.isTrue(signalled);
    }),
  );

  it.effect("expires an early settle that no waiter consumes", () =>
    Effect.gen(function* () {
      const receipts = yield* TradingExecutionReceipts;
      yield* receipts.settle({ missionId: "mission_1", executionSequence: 2 });
      yield* TestClock.adjust(Duration.millis(SETTLED_RECEIPT_RETENTION_MILLIS + 1));

      const waiter = yield* receipts
        .awaitSettled({ missionId: "mission_1", executionSequence: 2, timeoutMillis: 1 })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.millis(2));
      assert.isFalse(yield* Fiber.join(waiter));
    }),
  );
});
