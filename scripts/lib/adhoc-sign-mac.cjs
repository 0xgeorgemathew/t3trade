// Ad-hoc sign the packaged macOS app when there is no Apple identity.
//
// electron-builder does NOT do this for us. `mac.identity: null` reads like
// "sign with the ad-hoc identity" and means the opposite — `handleNullIdentity`
// logs "skipped macOS code signing" and returns. What ships without this hook
// is an app whose only signature is the one Apple's linker puts on the main
// binary, with no sealed resources, and macOS reports exactly that:
//
//   Code has no resources but signature indicates they must be present.
//
// A quarantined copy of that app — anything downloaded through a browser — is
// refused as "is damaged and can't be opened. You should move it to the
// Trash." That is what shipped in t3trade-v0.0.32, and it is why the same
// build ran fine from a local path: a file that never crossed the internet is
// never quarantined, so Gatekeeper never evaluates it.
//
// After this hook, `codesign --verify --deep --strict` reports "valid on disk"
// and "satisfies its Designated Requirement", and `syspolicy_check
// distribution` drops from two fatal findings to one: the missing notary
// ticket. That remaining one is real — only a paid Apple Developer ID plus
// notarization clears it, and until then a downloaded copy still needs its
// quarantine flag cleared (scripts/install-macos.sh does it). The difference
// this hook makes is between an app macOS refuses outright and one the user
// can choose to open.
//
// CommonJS on purpose: electron-builder `require`s hook files by path.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSignMac(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // --deep is the wrong tool for a real identity (Apple says so: it does not
  // sign nested code in dependency order). For an ad-hoc signature over an
  // Electron bundle whose frameworks and helpers are already linker-signed it
  // is the one that produces a bundle macOS validates, which is the whole
  // point here.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });

  // Fail the build rather than ship another "damaged" DMG: an ad-hoc
  // signature that does not validate is the exact defect this exists to stop,
  // and it is silent at every later step.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });

  console.log(`[adhoc-sign-mac] ad-hoc signed and verified ${appPath}`);
};
