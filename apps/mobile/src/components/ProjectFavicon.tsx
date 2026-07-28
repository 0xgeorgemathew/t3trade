import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { useThemeColor } from "../lib/useThemeColor";
import { useAssetUrl } from "../state/assets";

/* ─── Favicon cache (matches web pattern) ────────────────────────────── */
const loadedFaviconKeys = new Set<string>();

/* ─── Component ──────────────────────────────────────────────────────── */
export function ProjectFavicon(props: {
  readonly environmentId: EnvironmentId;
  readonly open?: boolean;
  readonly size?: number;
  readonly projectTitle: string;
  readonly workspaceRoot?: string | null;
}) {
  const size = props.size ?? 42;
  const faviconUrl = useAssetUrl(
    props.environmentId,
    props.workspaceRoot === null || props.workspaceRoot === undefined
      ? null
      : { _tag: "project-favicon", cwd: props.workspaceRoot },
  );
  const renderableFaviconUrl = isProjectFaviconFallbackUrl(faviconUrl) ? null : faviconUrl;
  const cacheKey =
    renderableFaviconUrl && props.workspaceRoot
      ? getProjectFaviconCacheKey(props.environmentId, props.workspaceRoot, renderableFaviconUrl)
      : null;

  return (
    <ProjectFaviconImage
      key={cacheKey}
      cacheKey={cacheKey}
      faviconUrl={renderableFaviconUrl}
      open={props.open}
      projectTitle={props.projectTitle}
      size={size}
    />
  );
}

function ProjectFaviconImage(props: {
  readonly cacheKey: string | null;
  readonly faviconUrl: string | null;
  readonly open?: boolean;
  readonly projectTitle: string;
  readonly size: number;
}) {
  const iconMuted = useThemeColor("--color-icon-subtle");

  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    props.cacheKey && loadedFaviconKeys.has(props.cacheKey) ? "loaded" : "loading",
  );

  const showImage = props.faviconUrl !== null && status === "loaded";

  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Folder icon fallback (matches web's FolderIcon) */}
      {!showImage ? (
        <SymbolView
          name={{ ios: "folder.fill", android: props.open ? "folder_open" : "folder" }}
          size={props.size * 0.78}
          tintColor={iconMuted}
          type="monochrome"
        />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {props.faviconUrl ? (
        <Image
          source={{
            uri: props.faviconUrl,
            ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
          }}
          cachePolicy="memory-disk"
          recyclingKey={props.cacheKey}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          onLoad={() => {
            if (props.cacheKey) loadedFaviconKeys.add(props.cacheKey);
            setStatus("loaded");
          }}
          onError={() => setStatus("error")}
        />
      ) : null}
    </View>
  );
}
