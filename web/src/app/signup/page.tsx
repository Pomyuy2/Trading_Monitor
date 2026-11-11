'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, useEffect } from 'react';
import { signIn } from 'next-auth/react';
import { encodePayload } from '@tm/shared';
import { EyeIcon, EyeOffIcon, LogoIcon, MoonIcon, SunIcon, UserIcon } from '@/components/icons';
import { cx, useLang } from '@/components/ui';
import { loadPref, restoreCookie, savePref, setTheme, useTheme, type Theme } from '@/lib/prefs';

export default function SignUpPage() {
  const t = useTranslations();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password || !inviteCode.trim()) return;

    if (password.length < 6) {
      setError(t('auth.errorPasswordTooShort'));
      return;
    }

    if (password !== confirmPassword) {
      setError(t('auth.errorPasswordMismatch'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: encodePayload(email.trim().toLowerCase()),
          password: encodePayload(password),
          inviteCode: inviteCode.trim(),
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        if (res.status === 429) {
          setError(t('auth.errorRateLimit'));
        } else if (res.status === 409) {
          setError(t('auth.errorEmailExists'));
        } else if (data?.error === 'invalid_invite') {
          setError(t('auth.errorInvalidInvite', { remaining: data.remaining ?? 0 }));
        } else {
          setError(data?.message || t('auth.errorGeneric'));
        }
        setLoading(false);
        return;
      }

      // Successful registration -> sign in immediately
      const signInRes = await signIn('credentials', {
        email: encodePayload(email.trim().toLowerCase()),
        password: encodePayload(password),
        redirect: false,
        redirectTo: '/',
      });

      if (signInRes?.error) {
        router.push('/login');
      } else {
        window.location.href = '/';
      }
    } catch (err) {
      console.error('Registration error:', err);
      setError(t('auth.errorGeneric'));
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      {/* Top navigation with Theme and Language */}
      <header className="flex h-16 items-center justify-between border-b border-border px-4 sm:px-6">
        <div className="flex items-center gap-2.5 font-semibold text-text">
          <span className="grid size-8 place-items-center rounded-md bg-button text-white">
            <LogoIcon width={18} height={18} />
          </span>
          <span className="text-base sm:text-lg">{t('app.title')}</span>
        </div>

        <div className="flex items-center gap-2">
          <SignUpThemeToggle />
          <SignUpLanguageSwitch />
        </div>
      </header>

      {/* Main card */}
      <main className="flex flex-1 items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="rounded-2xl border border-border bg-panel p-6 sm:p-8 shadow-xl">
            <div className="text-center">
              <div className="mx-auto grid size-12 place-items-center rounded-xl bg-accent/10 text-accent">
                <UserIcon width={24} height={24} />
              </div>
              <h1 className="mt-4 text-xl font-bold tracking-tight text-text sm:text-2xl">
                {t('auth.signUpTitle')}
              </h1>
              <p className="mt-2 text-xs sm:text-sm text-muted leading-relaxed">
                {t('auth.signUpSubtitle')}
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="mt-6 rounded-lg border border-down/30 bg-down/10 px-4 py-3 text-xs sm:text-sm text-down animate-in fade-in duration-200"
              >
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label htmlFor="signup-email" className="block text-xs font-medium text-text mb-1.5">
                  {t('auth.email')}
                </label>
                <input
                  id="signup-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('auth.emailPlaceholder')}
                  disabled={loading}
                  className="w-full rounded-lg border border-border bg-panel-2 px-3.5 py-2.5 text-sm text-text placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-50 transition-colors"
                />
              </div>

              <div>
                <label htmlFor="signup-password" className="block text-xs font-medium text-text mb-1.5">
                  {t('auth.password')}
                </label>
                <div className="relative">
                  <input
                    id="signup-password"
                    type={showPass ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('auth.passwordPlaceholder')}
                    disabled={loading}
                    className="w-full rounded-lg border border-border bg-panel-2 px-3.5 py-2.5 pr-10 text-sm text-text placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-50 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-text p-1"
                    aria-label={showPass ? t('auth.hidePassword') : t('auth.showPassword')}
                    tabIndex={-1}
                  >
                    {showPass ? <EyeOffIcon width={16} height={16} /> : <EyeIcon width={16} height={16} />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="signup-confirm-password" className="block text-xs font-medium text-text mb-1.5">
                  {t('auth.confirmPassword')}
                </label>
                <div className="relative">
                  <input
                    id="signup-confirm-password"
                    type={showConfirmPass ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('auth.confirmPasswordPlaceholder')}
                    disabled={loading}
                    className="w-full rounded-lg border border-border bg-panel-2 px-3.5 py-2.5 pr-10 text-sm text-text placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-50 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPass(!showConfirmPass)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-text p-1"
                    aria-label={showConfirmPass ? t('auth.hidePassword') : t('auth.showPassword')}
                    tabIndex={-1}
                  >
                    {showConfirmPass ? <EyeOffIcon width={16} height={16} /> : <EyeIcon width={16} height={16} />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="signup-invite-code" className="block text-xs font-medium text-text mb-1.5">
                  {t('auth.inviteCode')}
                </label>
                <input
                  id="signup-invite-code"
                  type="text"
                  required
                  autoComplete="off"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder={t('auth.inviteCodePlaceholder')}
                  disabled={loading}
                  className="w-full rounded-lg border border-border bg-panel-2 px-3.5 py-2.5 text-sm text-text placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-50 transition-colors font-mono tracking-wider"
                />
              </div>

              <button
                type="submit"
                disabled={loading || !email.trim() || !password || !confirmPassword || !inviteCode.trim()}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-button py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-button-hover disabled:opacity-50 disabled:hover:bg-button min-h-11"
              >
                {loading ? (
                  <>
                    <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    <span>{t('auth.registerSubmitting')}</span>
                  </>
                ) : (
                  <span>{t('auth.registerSubmit')}</span>
                )}
              </button>
            </form>

            {/* Link back to login */}
            <div className="mt-6 text-center text-xs sm:text-sm text-muted">
              {t('auth.alreadyHaveAccount')}{' '}
              <Link
                href="/login"
                className="font-semibold text-accent hover:underline focus:outline-none"
              >
                {t('auth.signIn')}
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function SignUpThemeToggle() {
  const t = useTranslations('header');
  const theme = useTheme();
  useEffect(() => {
    const saved = loadPref('theme') as Theme | null;
    if (saved && saved !== document.documentElement.dataset.theme) setTheme(saved);
  }, []);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={t(next === 'light' ? 'lightTheme' : 'darkTheme')}
      title={t(next === 'light' ? 'lightTheme' : 'darkTheme')}
      className="inline-flex size-10 items-center justify-center rounded-md border border-border text-muted hover:bg-panel-2 hover:text-text transition-colors"
    >
      {theme === 'dark' ? <SunIcon width={18} height={18} /> : <MoonIcon width={18} height={18} />}
    </button>
  );
}

function SignUpLanguageSwitch() {
  const t = useTranslations('header');
  const lang = useLang();
  const router = useRouter();
  const [pending, start] = useTransition();

  useEffect(() => {
    if (restoreCookie('lang')) start(() => router.refresh());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (l: 'en' | 'th') => {
    if (l === lang) return;
    savePref('lang', l);
    start(() => router.refresh());
  };

  return (
    <div role="group" aria-label={t('language')} className={cx('flex shrink-0 rounded-md border border-border p-0.5', pending && 'opacity-60')}>
      {(['en', 'th'] as const).map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={lang === l}
          onClick={() => set(l)}
          className={cx(
            'min-h-9 min-w-9 rounded px-2 text-xs font-medium transition-colors',
            lang === l ? 'bg-button text-white' : 'text-muted hover:text-text',
          )}
        >
          {l === 'en' ? 'EN' : 'TH'}
        </button>
      ))}
    </div>
  );
}
