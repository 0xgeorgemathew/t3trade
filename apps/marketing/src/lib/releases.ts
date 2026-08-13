const REPO = "0xgeorgemathew/t3trade";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

// The list endpoint (unlike /releases/latest) also returns prereleases,
// so the download page keeps working if a release is flagged pre-release.
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=1`;
const CACHE_KEY = "t3trade-latest-release";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export async function fetchLatestRelease(): Promise<Release | undefined> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const releases = await fetch(API_URL).then((r) => r.json());
  const data = Array.isArray(releases) ? releases[0] : undefined;

  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  return data;
}
