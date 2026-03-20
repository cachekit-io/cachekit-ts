interface SessionInfo {
  id: string;
  startMs: number;
}

let session: SessionInfo | null = null;

function getOrCreateSession(): SessionInfo {
  if (!session) {
    session = { id: crypto.randomUUID(), startMs: Date.now() };
  }
  return session;
}

export function getSessionHeaders(): Record<string, string> {
  const s = getOrCreateSession();
  return {
    'X-CacheKit-Session-ID': s.id,
    'X-CacheKit-Session-Start': String(s.startMs),
  };
}

export function _resetSessionForTesting(): void {
  session = null;
}
