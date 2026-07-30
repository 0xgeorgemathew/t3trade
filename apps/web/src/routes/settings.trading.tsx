import { createFileRoute } from "@tanstack/react-router";

import { TradingWorkspacePanel } from "../components/trading/TradingWorkspacePanel";

export const Route = createFileRoute("/settings/trading")({
  component: TradingWorkspacePanel,
});
