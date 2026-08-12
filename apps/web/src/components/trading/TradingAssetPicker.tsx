/**
 * The start-page asset picker.
 *
 * A mission's market is fixed at creation (§10.1), so the only moment the user
 * can choose it is before the first message is sent. The picker therefore lives
 * in the draft composer's footer, beside the other pre-send choices, and the
 * selected market rides the first turn's `tradingMarket` field into the
 * auto-mission create path.
 *
 * @module TradingAssetPicker
 */
import type { TradingMarket } from "@t3tools/trading-contracts";

import { ComposerSelectControl } from "../chat/ComposerControl";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Separator } from "../ui/separator";

const ASSETS: ReadonlyArray<TradingMarket> = ["BTC", "ETH"];

export function TradingAssetPicker({
  value,
  onChange,
}: {
  value: TradingMarket;
  onChange: (market: TradingMarket) => void;
}) {
  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
      >
        <ComposerSelectControl className="font-medium" aria-label="Trading asset">
          <SelectValue>{value}</SelectValue>
        </ComposerSelectControl>
        <SelectPopup alignItemWithTrigger={false}>
          {ASSETS.map((asset) => (
            <SelectItem key={asset} value={asset}>
              {asset}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </>
  );
}
