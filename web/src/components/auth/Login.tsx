// La pantalla de entrada. Solo aparece cuando el servidor pide contraseña y no hay sesión.
//
// Pide la contraseña y, si el servidor tiene segundo factor, el código de la app de
// autenticación. Los errores vienen del servidor tal cual («Contraseña incorrecta»,
// «Demasiados intentos. Espera 900 s»): no se adivina nada aquí.

import { useEffect, useState } from 'react';
import { entrar } from '../../lib/auth';
import { AppMark, LockIcon } from '../icons';
import { useI18n } from '../../i18n';

export default function Login({ totp, onEntrar }: { totp: boolean; onEntrar: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [espera, setEspera] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const pideCodigo = totp;

  useEffect(() => {
    if (espera <= 0) return;
    const reloj = setTimeout(() => setEspera((s) => s - 1), 1000);
    return () => clearTimeout(reloj);
  }, [espera]);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (enviando || espera > 0) return;
    setEnviando(true);
    setError(null);
    const r = await entrar(password, pideCodigo ? codigo : undefined);
    setEnviando(false);
    if (r.ok) {
      onEntrar();
      return;
    }
    setError(r.error);
    if (r.espera) setEspera(r.espera);
    setPassword('');
    setCodigo('');
  }

  return (
    <div className="grid min-h-screen place-items-center bg-(--surface-page) px-4">
      <form onSubmit={enviar} className="w-full max-w-sm rounded-2xl border border-(--line) bg-(--surface-card) p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-3">
          <AppMark size={36} />
          <div>
            <h1 className="text-[17px] font-semibold leading-tight text-(--ink-strong)">Sports Predictor</h1>
            <p className="text-[12.5px] text-(--ink-muted)">{t('login.pide')}</p>
          </div>
        </div>
        <label className="block text-[12px] uppercase tracking-wide text-(--ink-muted)" htmlFor="login-password">
          {t('login.contrasena')}
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-(--line) bg-(--surface-page) px-3 py-2 text-[15px] text-(--ink-strong) outline-none focus:border-[#3987e5]"
        />
        {pideCodigo && (
          <>
            <label className="mt-4 block text-[12px] uppercase tracking-wide text-(--ink-muted)" htmlFor="login-codigo">
              {t('login.codigo')}
            </label>
            <input
              id="login-codigo"
              inputMode="numeric"
              pattern="[0-9 ]*"
              autoComplete="one-time-code"
              placeholder="123 456"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              className="mt-1 w-full rounded-lg border border-(--line) bg-(--surface-page) px-3 py-2 text-[15px] tabular-nums text-(--ink-strong) outline-none focus:border-[#3987e5]"
            />
          </>
        )}
        {error && (
          <p className="mt-3 text-[13px] text-(--status-critical)" role="alert">
            {error}
            {espera > 0 && t('login.espera', { s: espera })}
          </p>
        )}
        <button
          type="submit"
          disabled={enviando || espera > 0}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#3987e5] px-3 py-2.5 text-[14px] font-semibold text-[#0b1220] transition hover:bg-[#4a93ea] disabled:opacity-50"
        >
          <LockIcon size={16} />
          {enviando ? t('login.entrando') : t('login.entrar')}
        </button>
        <p className="mt-4 text-[12px] leading-relaxed text-(--ink-muted)">
          {t('login.sesion')}
        </p>
      </form>
    </div>
  );
}
