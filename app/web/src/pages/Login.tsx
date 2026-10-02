/**
 * Giriş ekranı. Kimlik yoksa TAM EKRAN; panelin hiçbir parçası görünmez.
 * Şifre sunucu tarafında `SP_ADMIN_PASSWORD` ile tanımlanır — değeri burada yok.
 */
import { useState } from "react";

import { endpoints } from "../api/endpoints.js";
import { useAction } from "../api/hooks.js";
import { Button, ErrorBox, Field, TextInput } from "../components/Ui.js";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const action = useAction();

  const submit = async (): Promise<void> => {
    const ok = await action.run(() => endpoints.login(password));
    if (ok) {
      setPassword("");
      onSignedIn();
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded border border-line bg-panel p-5">
        <h1 className="text-[16px] font-semibold text-fg">Yayın paneline giriş</h1>
        <p className="mt-1 text-[12px] text-muted">
          Bu panel yerelde çalışır. Şifre sunucu ortam değişkeninde tanımlıdır.
        </p>

        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Parola" htmlFor="sp-password">
            <TextInput
              id="sp-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          </Field>

          {action.error === null ? null : <ErrorBox error={action.error} context="Giriş başarısız" />}

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" busy={action.busy} disabled={password === ""}>
              Giriş yap
            </Button>
            <span className="font-mono text-[11px] text-faint">SP_ADMIN_PASSWORD</span>
          </div>
        </form>
      </div>
    </main>
  );
}