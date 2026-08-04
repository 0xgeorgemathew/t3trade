import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import { resolveMissionLockedProviderMessages } from "./missionLockedProviderMessages";

describe("resolveMissionLockedProviderMessages", () => {
  it("returns all-null when no mission lock is present (generic strings apply)", () => {
    const messages = resolveMissionLockedProviderMessages(null);
    expect(messages.placeholder).toBeNull();
    expect(messages.banner).toBeNull();
    expect(messages.footerLabel).toBeNull();
  });

  it("names the bound driver when a mission lock has no selectable instance", () => {
    // The real Claude driver kind is the branded slug "claudeAgent"; the helper
    // must resolve it to the "Claude" display name, not echo the raw slug.
    const messages = resolveMissionLockedProviderMessages(ProviderDriverKind.make("claudeAgent"));
    expect(messages.placeholder).toBe("Enable Claude in Settings");
    expect(messages.footerLabel).toBe("Claude not enabled");
    expect(messages.banner).toBe(
      "This trading mission is bound to Claude. Enable it in Settings, or end the mission to use another provider.",
    );
  });

  it("falls back to the raw slug for a driver without a display name", () => {
    const messages = resolveMissionLockedProviderMessages(
      ProviderDriverKind.make("some-new-driver"),
    );
    expect(messages.placeholder).toBe("Enable some-new-driver in Settings");
    expect(messages.footerLabel).toBe("some-new-driver not enabled");
  });

  it("chooses the mission-specific message for every known trading provider", () => {
    // The agreed trading providers: each lock must name itself, not the generic
    // "no provider available" string.
    for (const slug of ["claudeAgent", "opencode", "codex", "cursor", "grok"]) {
      const messages = resolveMissionLockedProviderMessages(ProviderDriverKind.make(slug));
      expect(messages.placeholder).not.toBeNull();
      expect(messages.banner).not.toBeNull();
      expect(messages.footerLabel).not.toBeNull();
    }
  });
});
