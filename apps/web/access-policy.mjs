const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function hostname(host = '') {
  const value = host.toLocaleLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':', 1)[0];
}

export function authorizeRequest({ remoteAddress, host, tailscaleLogin }, allowedUsers) {
  if (typeof tailscaleLogin === 'string' && tailscaleLogin.trim()) {
    return allowedUsers.has(tailscaleLogin.trim().toLocaleLowerCase());
  }

  // Tailscale Serve proxies to this loopback listener. A loopback peer alone
  // therefore does not prove that the original browser is on the host.
  return LOOPBACK_ADDRESSES.has(remoteAddress ?? '') && LOOPBACK_HOSTS.has(hostname(host));
}
