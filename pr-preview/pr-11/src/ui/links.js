// Chat links: the open chat's id lives in the URL's hash (#chat=<id>), so a chat can be bookmarked, shared to
// another of your devices, or reopened with back/forward. A hash, not a path, because both hosts serve one
// index.html (GitHub Pages has no fallback for /chat/<id>) and a hash never reaches the server.
//
// Opening a link only works for a chat this account has: the id is looked up in your own storage repo, so
// anyone else (or a signed-out browser) just gets their usual chat. A link to a chat this device hasn't synced
// yet waits for the first sync before giving up.

const KEY = 'chat';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The chat id in a hash ("#chat=s0abc" → "s0abc"), or '' when there's none or it isn't an id. */
export function chatIdFromHash(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const id = p.get(KEY) || '';
  return ID.test(id) ? id : '';
}

/** The hash for a chat ("" for none), keeping any other keys in the current hash. */
export function hashFor(id, current = '') {
  const p = new URLSearchParams(String(current || '').replace(/^#/, ''));
  if (id) p.set(KEY, id); else p.delete(KEY);
  const s = p.toString();
  return s ? `#${s}` : '';
}

/** The full link to a chat on this site. */
export function chatLink(id, loc = location) {
  return `${loc.origin}${loc.pathname}${hashFor(id)}`;
}

/** Puts a chat in the address bar. mode: 'push' (a new history entry, so back returns to the previous chat),
 *  'replace', or 'none'. */
export function showChatInUrl(id, mode = 'push') {
  if (mode === 'none' || typeof history === 'undefined') return;
  const hash = hashFor(id, location.hash);
  if (hash === (location.hash || '')) return;
  const url = `${location.pathname}${location.search}${hash}`;
  try {
    if (mode === 'replace') history.replaceState(history.state, '', url);
    else history.pushState({ chat: id }, '', url);
  } catch {}
}

/** The chat the URL asks for right now ('' for none). */
export const requestedChat = () => (typeof location === 'undefined' ? '' : chatIdFromHash(location.hash));
