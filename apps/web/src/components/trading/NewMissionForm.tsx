import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { POC_DEFAULT_INSTRUCTION } from "@t3tools/trading-contracts/strategy";
import { useMemo, useState } from "react";

import { refreshTradingMissions } from "../../lib/tradingMissionsState";
import { useEnvironmentThreadRefs, useThreadShells } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { newMissionBlocker, selectableMissionThreads } from "./tradingPresentation";

/**
 * The account row the server provisions from the interim signer.
 *
 * Mirrors `LOCAL_TRADING_ACCOUNT_ID` in `TradingAccountBootstrap.ts`. Kept as a
 * prefilled default rather than a hidden constant so a different account can be
 * typed in once Privy provisions real ones.
 */
const LOCAL_TRADING_ACCOUNT_ID = "local-hyperliquid-testnet";

const DEFAULT_INSTRUCTION = POC_DEFAULT_INSTRUCTION;
const DEFAULT_CAPITAL_USD = 50;

/**
 * Seeds a mission onto a thread (development builds only).
 *
 * This is a stand-in for the onboarding flow PROMPT-06 brings, not a product
 * surface: it dispatches the same `trading.mission.create` command the real
 * flow will, so everything downstream — the reactor, the first harness turn,
 * the §14.7 controls — is exercised on the genuine path.
 */
export function NewMissionForm({
  environmentId,
  boundThreadIds,
  hasActiveMission,
}: {
  environmentId: EnvironmentId;
  boundThreadIds: ReadonlySet<string>;
  /** One active mission per user is a domain invariant, not a UI preference. */
  hasActiveMission: boolean;
}) {
  const threadRefs = useEnvironmentThreadRefs(environmentId);
  const allShells = useThreadShells();
  const dispatchCreate = useAtomCommand(orchestrationEnvironment.missionCreate);

  const [threadId, setThreadId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION);
  const [capital, setCapital] = useState(String(DEFAULT_CAPITAL_USD));
  const [accountId, setAccountId] = useState(LOCAL_TRADING_ACCOUNT_ID);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => {
    const ids = new Set(threadRefs.map((ref) => ref.threadId));
    const shells = allShells.filter((shell) => ids.has(shell.id));
    return selectableMissionThreads(shells, boundThreadIds);
  }, [threadRefs, allShells, boundThreadIds]);

  const allocatedCapitalUsd = Number(capital);
  const blocker = newMissionBlocker({
    threadId,
    instruction,
    allocatedCapitalUsd,
    tradingAccountId: accountId,
    hasActiveMission,
  });

  const submit = () => {
    if (blocker !== null || threadId === null) return;
    setIsBusy(true);
    setError(null);
    void dispatchCreate({
      environmentId,
      input: {
        threadId: threadId as ThreadId,
        tradingAccountId: accountId.trim(),
        instruction: instruction.trim(),
        allocatedCapitalUsd,
      },
    })
      .then(() => {
        // The command only records the intent; the reactor writes the mission a
        // moment later. Read the projection back rather than waiting out the
        // poll, so the new mission is on screen by the time the button re-arms.
        refreshTradingMissions(environmentId);
      })
      .catch((cause: unknown) => {
        setError(String(cause));
      })
      .finally(() => setIsBusy(false));
  };

  return (
    <SettingsSection title="New mission (development)">
      <p className="px-3 pt-2 text-sm text-muted-foreground sm:px-4">
        Binds a mission to a thread and starts its first harness turn. Account onboarding lands in a
        later phase; until then the account below is the row the server provisions from the interim
        signer.
      </p>

      <div className="space-y-3 px-3 py-3 sm:px-4">
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No free thread on this environment. Open a new chat thread first — an archived thread is
            not offered, and a thread that already carries a live mission cannot take another.
          </p>
        ) : (
          <Select value={threadId} onValueChange={(value: string | null) => setThreadId(value)}>
            <SelectTrigger className="w-full" aria-label="Thread">
              {/* Without children the trigger prints the raw threadId, which
                  is the one thing a picker of threads must not show. */}
              <SelectValue placeholder="Pick a thread">
                {options.find((option) => option.threadId === threadId)?.title}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {options.map((option) => (
                <SelectItem key={option.threadId} value={option.threadId}>
                  {option.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}

        <Input
          aria-label="Instruction"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="What the harness should do"
        />
        <Input
          aria-label="Allocated capital (USD)"
          value={capital}
          inputMode="decimal"
          onChange={(event) => setCapital(event.target.value)}
          placeholder="Allocated capital (USD)"
        />
        <Input
          aria-label="Trading account"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          placeholder="Trading account id"
        />

        {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
        {blocker === null ? null : <p className="text-sm text-muted-foreground">{blocker}</p>}

        <Button size="sm" disabled={isBusy || blocker !== null} onClick={submit}>
          Create mission
        </Button>
      </div>
    </SettingsSection>
  );
}
