// When this client started tracking unread sessions. opencode keeps each
// session's last finished turn (`time.idle`) and when one was last viewed
// (`time.viewed`); sessions that finished before the first run never had a
// view recorded, so only turns after this count as unread.

const KEY = "thinkite:unread-since";

function load(): number {
  try {
    const stored = Number(localStorage.getItem(KEY));
    if (stored > 0) return stored;
    const now = Date.now();
    localStorage.setItem(KEY, String(now));
    return now;
  } catch {
    return Date.now();
  }
}

export const UNREAD_SINCE = load();
