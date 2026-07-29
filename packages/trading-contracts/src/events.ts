/**
 * Mission event inbox - spec §18.1.
 *
 * Observed facts are persisted as inbox events keyed for deduplication, then
 * coalesced before a run consumes them. An event moves
 * pending -> included_in_run -> consumed, so a queued event is never silently
 * lost and a run always sees the coalesced set it was started with.
 *
 * @module MissionInboxEvent
 */
import { Schema } from "effect";
import { TradingId, UnixMillis } from "./primitives.ts";

export const MissionInboxEventCategory = Schema.Literals([
  "market",
  "exchange",
  "timer",
  "user",
  "system",
]);
export type MissionInboxEventCategory = typeof MissionInboxEventCategory.Type;

export const MissionInboxEventStatus = Schema.Literals(["pending", "included_in_run", "consumed"]);
export type MissionInboxEventStatus = typeof MissionInboxEventStatus.Type;

export const MissionInboxEvent = Schema.Struct({
  id: TradingId,
  missionId: TradingId,
  category: MissionInboxEventCategory,
  deduplicationKey: Schema.String,
  payload: Schema.Unknown,
  status: MissionInboxEventStatus,
  occurredAt: UnixMillis,
});
export type MissionInboxEvent = typeof MissionInboxEvent.Type;
