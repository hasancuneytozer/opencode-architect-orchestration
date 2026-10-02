/**
 * Küçük veri çekme kancası. Gereksiz soyutlama yok: durum, hata, yenileme.
 * Hata YOK sayılmaz — `error` ayrı bir durumdur, "boş liste" ile karıştırılmaz.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** İlk yükleme bitti mi (yoksa "boş" gösterilmemeli). */
  settled: boolean;
  reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], enabled = true): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [settled, setSettled] = useState(false);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fn()
      .then((value) => {
        if (cancelled || !alive.current) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled || !alive.current) return;
        setError(cause);
      })
      .finally(() => {
        if (cancelled || !alive.current) return;
        setLoading(false);
        setSettled(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, settled, reload };
}

/** Tek seferlik eylem (onayla, iptal et, yeniden dene) için durum. */
export interface ActionState {
  busy: boolean;
  error: unknown;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
}

export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run };
}

/** `<video>` gibi medya için hazır olma bayrağı. */
export function useMediaReady(): [boolean, (ready: boolean) => void] {
  const [ready, setReady] = useState(false);
  return [ready, setReady];
}