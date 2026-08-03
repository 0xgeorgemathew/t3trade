import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_IOC_EXIT_SLIPPAGE_BPS,
  DEFAULT_IOC_SLIPPAGE_BPS,
  resolveIocSlippage,
} from "./IocSlippageConfig.ts";

describe("IocSlippageConfig", () => {
  it("uses the documented defaults when nothing is set", () => {
    const settings = resolveIocSlippage({});
    expect(settings.entryBps).toBe(DEFAULT_IOC_SLIPPAGE_BPS);
    expect(settings.exitBps).toBe(DEFAULT_IOC_EXIT_SLIPPAGE_BPS);
  });

  it("reads each knob independently", () => {
    const settings = resolveIocSlippage({
      T3_TRADES_IOC_SLIPPAGE_BPS: "25",
      T3_TRADES_IOC_EXIT_SLIPPAGE_BPS: "200",
    });
    expect(settings.entryBps).toBe(25);
    expect(settings.exitBps).toBe(200);
  });

  it("falls back rather than trading on a value that is not a positive number", () => {
    for (const raw of ["", "abc", "0", "-10"]) {
      expect(resolveIocSlippage({ T3_TRADES_IOC_SLIPPAGE_BPS: raw }).entryBps).toBe(
        DEFAULT_IOC_SLIPPAGE_BPS,
      );
    }
  });
});
