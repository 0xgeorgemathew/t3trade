/**
 * Server-side re-exports of the trading domain contracts.
 *
 * Every trading module inside apps/server imports its schemas from here rather
 * than reaching into @t3tools/trading-contracts directly, so the server has one
 * place where the contract surface it depends on is visible.
 *
 * @module TradingSchemas
 */
export {
  TradingAccount,
  TradingAccountStatus,
  TradingEnvironment,
  TradingExecutionWallet,
  TradingExecutionWalletStatus,
  TradingMasterWallet,
} from "@t3tools/trading-contracts/account";

export {
  pocAuthorityDefaults,
  pocRiskPolicyDefaults,
  TradingAuthority,
  TradingAuthorityValidUntil,
  TradingDirection,
  TradingMarginMode,
  TradingRiskPolicy,
} from "@t3tools/trading-contracts/authority";

export {
  MissionInboxEvent,
  MissionInboxEventCategory,
  MissionInboxEventStatus,
} from "@t3tools/trading-contracts/events";

export {
  TradingHarnessBinding,
  TradingHarnessRun,
  TradingHarnessRunCause,
  TradingHarnessRunStatus,
  TradingHarnessStatus,
  TradingMission,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
  TradingProvider,
} from "@t3tools/trading-contracts/mission";

export {
  EvmAddress,
  Price,
  TradingId,
  TradingMarket,
  TradingText,
  UnixMillis,
  UsdAmount,
} from "@t3tools/trading-contracts/primitives";

export {
  AgentConditionDescription,
  MomentumProtection,
  MomentumStrategyAction,
  MomentumStrategyDirection,
  MomentumStrategyMode,
  MomentumStrategyState,
  ProfitTargetBasis,
  ProfitTargetMeasurement,
  TradingTimeframe,
} from "@t3tools/trading-contracts/strategy";

export {
  measureVolatility,
  ObservedVolatility,
  VOLATILITY_LOOKBACK_BARS,
  VolatilityHorizon,
} from "@t3tools/trading-contracts/volatility";

export {
  PublishMomentumStrategyBody,
  PublishMomentumStrategyRejection,
  TRADING_GET_MISSION_TOOL,
  TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL,
  TradingBoundMissionResult,
  TradingGetMissionInput,
  TradingGetMissionResult,
  TradingPendingExecution,
  TradingUnboundMissionResult,
  TradingPublishMomentumStrategyInput,
  TradingPublishMomentumStrategyResult,
  TradingToolRejectedError,
  TradingToolRejectionReason,
} from "@t3tools/trading-contracts/tools";

export {
  MarketWatch,
  PersistedWatch,
  PersistedWatchStatus,
  WatchArmedReason,
} from "@t3tools/trading-contracts/watch";

export {
  describeArmedWatch,
  HarnessRunRequest,
  HarnessRunOutcome,
  TradingDomainEventSummary,
  TradingHarnessWakeup,
  WakeupArmedWatch,
} from "@t3tools/trading-contracts/wakeup";

export {
  TRADING_CANCEL_WATCH_TOOL,
  TRADING_LIST_WATCHES_TOOL,
  TRADING_REGISTER_WATCH_TOOL,
  TRADING_SCHEDULE_REASSESSMENT_TOOL,
  TradingCancelWatchInput,
  TradingCancelWatchResult,
  TradingListWatchesInput,
  TradingListWatchesResult,
  TradingRegisterWatchInput,
  TradingRegisterWatchResult,
  TradingScheduleReassessmentInput,
  TradingScheduleReassessmentResult,
} from "@t3tools/trading-contracts/tools";
