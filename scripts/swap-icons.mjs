#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __filename = NodeURL.fileURLToPath(import.meta.url);
const __dirname = NodePath.dirname(__filename);
const rootDir = NodePath.resolve(__dirname, "..");

const THEMED_DIR = NodePath.join(rootDir, "assets", "themed-t3trade");
const BACKUP_DIR = NodePath.join(rootDir, "assets", "original-backup");
const STATE_FILE = NodePath.join(rootDir, "assets", ".asset-theme-state.json");

function getAllFiles(dir, base = dir) {
  let results = [];
  if (!NodeFS.existsSync(dir)) return results;
  const list = NodeFS.readdirSync(dir);
  for (const file of list) {
    const filePath = NodePath.join(dir, file);
    const stat = NodeFS.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(filePath, base));
    } else {
      results.push(NodePath.relative(base, filePath));
    }
  }
  return results;
}

function ensureDir(filePath) {
  const dir = NodePath.dirname(filePath);
  if (!NodeFS.existsSync(dir)) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
}

function copyFileSafe(src, dest) {
  ensureDir(dest);
  NodeFS.copyFileSync(src, dest);
}

function getActiveState() {
  if (NodeFS.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf-8"));
      if (data && data.activeTheme) {
        return data.activeTheme;
      }
    } catch {
      // ignore json parse errors
    }
  }
  return "original";
}

function saveState(theme, count) {
  ensureDir(STATE_FILE);
  NodeFS.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        activeTheme: theme,
        swappedAt: new Date().toISOString(),
        filesCount: count,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function ensureOriginalBackup(relativeFiles) {
  for (const relPath of relativeFiles) {
    const backupPath = NodePath.join(BACKUP_DIR, relPath);
    const activePath = NodePath.join(rootDir, relPath);
    if (!NodeFS.existsSync(backupPath)) {
      if (NodeFS.existsSync(activePath)) {
        copyFileSafe(activePath, backupPath);
      }
    }
  }
}

function swap() {
  if (!NodeFS.existsSync(THEMED_DIR)) {
    console.error(`Error: Themed directory not found at ${THEMED_DIR}`);
    process.exit(1);
  }

  const relativeFiles = getAllFiles(THEMED_DIR);
  if (relativeFiles.length === 0) {
    console.error(`Error: No themed assets found in ${THEMED_DIR}`);
    process.exit(1);
  }

  // Ensure original backup exists first
  ensureOriginalBackup(relativeFiles);

  const currentState = getActiveState();
  const nextState = currentState === "original" ? "t3trade" : "original";

  if (nextState === "t3trade") {
    // Swap original -> t3trade
    let swappedCount = 0;
    for (const relPath of relativeFiles) {
      const src = NodePath.join(THEMED_DIR, relPath);
      const dest = NodePath.join(rootDir, relPath);
      copyFileSafe(src, dest);
      swappedCount++;
    }
    saveState("t3trade", swappedCount);

    console.log(`\n✨ Swapped ${swappedCount} assets to T3 Trade theme!`);
    console.log(`   Active Theme : T3 Trade (Obsidian & Emerald Neon Aesthetic)`);
    console.log(`   Toggle back  : Run 'pnpm swap:icons' to restore original assets.\n`);
  } else {
    // Swap t3trade -> original
    let restoredCount = 0;
    for (const relPath of relativeFiles) {
      const src = NodePath.join(BACKUP_DIR, relPath);
      const dest = NodePath.join(rootDir, relPath);
      if (NodeFS.existsSync(src)) {
        copyFileSafe(src, dest);
        restoredCount++;
      }
    }
    saveState("original", restoredCount);

    console.log(`\n🔄 Restored ${restoredCount} original product assets!`);
    console.log(`   Active Theme : Original`);
    console.log(`   Toggle back  : Run 'pnpm swap:icons' to apply T3 Trade theme.\n`);
  }
}

swap();
