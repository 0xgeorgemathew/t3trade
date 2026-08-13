/** T3 Trade fork identity, exposed by the server and web/desktop clients so
    a running build can be traced back to the upstream T3 Code commit it was
    forked from (see docs/upstream/BASELINE.md). buildMetadata.test.ts checks
    T3_UPSTREAM_COMMIT against BASELINE.md's pinned SHA — update both
    together on every sync. */
export const T3_FORK_NAME = "T3 Trade" as const;
export const T3_UPSTREAM_COMMIT = "3b72d17cbca691f0b64e6d4a10c9e349f42873a5" as const;
