/**
 * The trading services the server runtime provides.
 *
 * All three are plain SQL-backed services over the migration-035 and -036
 * tables; they hold no process, no socket, and no provider state, so the whole
 * trading layer is just these on top of `SqlClient`.
 *
 * @module TradingRuntimeLayer
 */
import * as Layer from "effect/Layer";

import { TradingMissionProjectionLive } from "./TradingMissionProjection.ts";
import { TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingStrategyServiceLive } from "./TradingStrategyService.ts";

export const TradingLayerLive = Layer.mergeAll(
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
  TradingMissionProjectionLive,
);
