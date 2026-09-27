export function authorizeRequest(
  request: {
    readonly remoteAddress?: string;
    readonly host?: string;
    readonly tailscaleLogin?: string;
  },
  allowedUsers: ReadonlySet<string>,
): boolean;
