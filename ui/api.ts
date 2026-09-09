const fragment = new URLSearchParams(location.hash.slice(1));
const supplied = fragment.get('token');
if (supplied && /^[a-f0-9]{64}$/.test(supplied)) sessionStorage.setItem('mcp-context-hub-token', supplied);
if (location.hash) history.replaceState(null, '', location.pathname);
const token = sessionStorage.getItem('mcp-context-hub-token') ?? '';

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', credentials: 'omit',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '操作できませんでした。');
  return data as T;
}

export function openSmallWindow() {
  return Boolean(window.open(`${location.origin}/#token=${token}`, 'mcp-context-hub', 'popup,width=540,height=760,resizable=yes,scrollbars=yes'));
}

export function forgetToken() { sessionStorage.removeItem('mcp-context-hub-token'); }
