export function isMobileGatewayAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^\[|\]$/g, '');
    return !(
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.startsWith('127.') ||
      hostname === '0.0.0.0' ||
      hostname === '::' ||
      hostname === '::1' ||
      hostname === '::ffff:0:0' ||
      /^(?:::ffff:|::)7f[\da-f]{2}:/.test(hostname)
    );
  } catch {
    return false;
  }
}
