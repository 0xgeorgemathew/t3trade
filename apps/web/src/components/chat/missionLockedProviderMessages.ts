/**
 * Mission-locked provider messaging for the composer.
 *
 * When a live trading mission has bound a thread to a driver kind and no
 * selectable instance of that driver exists (it was disabled in Settings, or
 * its probe status went to error), the composer's "no provider available"
 * surface should name the bound driver so the user knows *why* the picker is
 * locked and exactly what to re-enable - not the generic string that leaves
 * them wondering.
 *
 * Pure and side-effect free so it can be unit-tested directly, the same way
 * `ComposerPrimaryActions` is.
 */
import { PROVIDER_DISPLAY_NAMES, type ProviderDriverKind } from "@t3tools/contracts";

/** Resolve the display name for a driver kind, with a readable fallback. */
export function providerDriverDisplayName(driver: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[driver] ?? driver;
}

export interface MissionLockedProviderMessages {
  /** null when the lock is not a mission lock (generic strings then apply). */
  readonly placeholder: string | null;
  /** Tooltip/banner copy; null when no mission-specific message applies. */
  readonly banner: string | null;
  /** Short button label for the footer "provider unavailable" affordance. */
  readonly footerLabel: string | null;
}

/**
 * Resolve the mission-specific provider-unavailable messages.
 *
 * Returns all-null when `missionLockedProvider` is null (a non-mission lock
 * such as a continued session does not carry the "enable this one" context, so
 * the caller falls back to its generic strings). When a mission lock names a
 * driver, every field is populated so the composer can show the bound driver
 * name everywhere the generic strings used to appear.
 */
export function resolveMissionLockedProviderMessages(
  missionLockedProvider: ProviderDriverKind | null,
): MissionLockedProviderMessages {
  if (missionLockedProvider === null) {
    return { placeholder: null, banner: null, footerLabel: null };
  }
  const displayName = providerDriverDisplayName(missionLockedProvider);
  return {
    placeholder: `Enable ${displayName} in Settings`,
    banner: `This trading mission is bound to ${displayName}. Enable it in Settings, or end the mission to use another provider.`,
    footerLabel: `${displayName} not enabled`,
  };
}
