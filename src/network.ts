import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, buildConnector } from 'undici';
import ipaddr from 'ipaddr.js';
import { HubError } from './errors.js';
import { securityDefaults, type Config } from './config.js';

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== 'unicast') return false;
    if (parsed.kind() === 'ipv6') return /^[23]/.test(parsed.toNormalizedString());
    return true;
  } catch { return false; }
}

export function validateAgentUrl(value: string, policy: Config['agent'], security = securityDefaults): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new HubError('Use an HTTP(S) MCP URL without credentials, query or fragment. Credentials belong in owner-defined templates.');
  }
  const allowed = policy.allowedHttpOrigins.some(origin => new URL(origin).origin === url.origin);
  if (!allowed) {
    if (!policy.allowPublicHttp || (security.requireHttps && url.protocol !== 'https:')) throw new HubError('This origin is not allowed. Public endpoints require HTTPS; private endpoints require owner policy.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (security.blockPrivateHttp && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !isPublicAddress(host)))) {
      throw new HubError('Private, loopback and special network addresses are blocked for agent-added URLs.');
    }
  }
  return url;
}

/** Resolve, validate and connect to the same IP on every new socket, preserving TLS hostname checks. */
export function guardedFetch(endpoint: string, allowPrivate: boolean, resolveHost: (host: string) => Promise<{ address: string; family: number }[]> = host => lookup(host, { all: true })) {
  const expected = new URL(endpoint);
  const connector = buildConnector({ timeout: 10000 });
  const dispatcher = new Agent({ connect: (options, callback) => {
    void (async () => {
      const host = options.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveHost(host);
      if (!addresses.length || (!allowPrivate && addresses.some(item => !isPublicAddress(item.address)))) {
        throw new HubError('Endpoint DNS resolved to a private or special network address.');
      }
      const address = addresses.find(item => item.family === 4) ?? addresses[0]!;
      connector({ ...options, hostname: address.address, servername: options.servername || host }, callback);
    })().catch(error => callback(error, null));
  } });
  return {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== expected.origin) throw new HubError('Cross-origin MCP requests are blocked.');
      const signal = init?.method === 'DELETE'
        ? AbortSignal.any([AbortSignal.timeout(1000), ...(init.signal ? [init.signal] : [])]) : init?.signal;
      const response = await fetch(input, { ...init, signal, redirect: 'manual', dispatcher } as RequestInit);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new HubError('MCP redirects are blocked. Register the final endpoint URL.');
      }
      if (!response.body) return response;
      let bytes = 0;
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 16 * 1024 * 1024) throw new HubError('HTTP MCP response exceeded 16 MiB.');
          controller.enqueue(chunk);
        },
      }));
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    close: () => dispatcher.destroy(),
  };
}
