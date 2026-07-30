/** T3 Trades fork identity, exposed by the server and web/desktop clients so
    a running build can be traced back to the upstream T3 Code commit it was
    forked from (see docs/upstream/BASELINE.md). buildMetadata.test.ts checks
    T3_UPSTREAM_COMMIT against BASELINE.md's pinned SHA — update both
    together on every sync. */
export const T3_FORK_NAME = "T3 Trades" as const;
export const T3_UPSTREAM_COMMIT = "a8e05cbb92633a1351529f2bc402071f615e5051" as const;
