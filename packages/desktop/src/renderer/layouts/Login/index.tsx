import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ArrowRight, CheckCircle2, HardDrive, Loader2, Phone, ShieldCheck, Sparkles } from 'lucide-react';
import logo from '@/assets/logo.png';
import { motion as motionPresets } from '@/styles/design-tokens';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import GuideMascot, { type GuideMascotPose } from '@/components/GuideMascot';

const RESEND_SECONDS = 60;

interface LoginProps {
  onSignedIn: () => void;
}

function normalizePhone(input: string): string {
  return input.replace(/\D/g, '').slice(0, 11);
}

/**
 * Opens a URL in the system browser.
 *
 * A plain <a href> would navigate the Electron renderer away from the app, so
 * we go through window.open: main's setWindowOpenHandler intercepts it and
 * calls shell.openExternal, then denies the in-app navigation.
 */
function openExternal(url: string): void {
  window.open(url, '_blank');
}

/** Renders the agreement sentence with its {0}/{1} slots as external links. */
function AgreementLinks({
  template,
  termsLabel,
  privacyLabel,
  termsUrl,
  privacyUrl,
}: {
  template: string;
  termsLabel: string;
  privacyLabel: string;
  termsUrl: string;
  privacyUrl: string;
}) {
  const linkClass = 'text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--accent)]';
  const parts = template.split(/(\{[01]\})/);

  return (
    <span>
      {parts.map((part, index) => {
        if (part === '{0}') {
          return (
            <button key={index} type="button" onClick={() => openExternal(termsUrl)} className={linkClass}>
              {termsLabel}
            </button>
          );
        }
        if (part === '{1}') {
          return (
            <button key={index} type="button" onClick={() => openExternal(privacyUrl)} className={linkClass}>
              {privacyLabel}
            </button>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </span>
  );
}

export default function Login({ onSignedIn }: LoginProps) {
  const { t } = useTranslation();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [mascotPose, setMascotPose] = useState<GuideMascotPose>('idle');
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    if (phase === 'code') codeInputRef.current?.focus();
  }, [phase]);

  const phoneValid = /^1[3-9]\d{9}$/.test(phone);
  const codeValid = /^\d{4,6}$/.test(code);

  /**
   * Maps the main process's error code to a localised message.
   *
   * The IPC error string is not shown directly: it comes from Supabase/SMS
   * upstream and is English, and for throttling it only says
   * "Service currently unavailable due to hook", which tells the user nothing.
   */
  const describeSendError = useCallback(
    (errorCode?: string): string => {
      switch (errorCode) {
        case 'otp_rate_limited':
          return t('login.rateLimited', { seconds: RESEND_SECONDS });
        case 'otp_hook_failed':
        case 'otp_send_failed':
          return t('login.serviceUnavailable');
        default:
          return t('login.sendFailed');
      }
    },
    [t],
  );

  const sendCode = useCallback(async () => {
    if (!phoneValid || busy) return;
    setBusy(true);
    setError('');
    let res: Awaited<ReturnType<typeof window.clawwork.commercialSendOtp>>;
    try {
      res = await window.clawwork.commercialSendOtp(`+86${phone}`);
    } catch {
      res = { ok: false, errorCode: 'otp_send_failed' };
    }
    setBusy(false);

    // Start the cooldown on every attempt, not just success. Throttling is
    // enforced upstream (Aliyun allows 1 SMS/minute/number), so letting the
    // user re-click immediately only deepens the lockout.
    setPhase('code');
    setCountdown(RESEND_SECONDS);

    if (!res.ok) {
      setError(describeSendError(res.errorCode));
      return;
    }
    toast.success(t('login.codeSent', { phone }));
  }, [busy, describeSendError, phone, phoneValid, t]);

  /**
   * 校验失败时**必须分原因**说。
   *
   * ⭐ 实机 bug（2026-09-17）：校验请求超时，界面却统一说「验证码不正确或已过期」
   * ⇒ 用户拿同一个码再试 ⇒ 而 OTP 是一次性的、那次超时的请求其实已把它消费掉
   * ⇒ 第二次必然失败，表现成"收到验证码却登不上"。
   * 说明里要提醒「验证码是一次性的，请重新发送」，把人从重试死循环里拉出来。
   */
  const describeVerifyError = useCallback(
    (errorCode?: string): string => {
      if (errorCode === 'otp_verify_unreachable') return t('login.verifyUnreachable');
      if (errorCode === 'otp_verify_too_many') return t('login.verifyTooMany');
      return t('login.verifyFailed');
    },
    [t],
  );

  const submit = useCallback(async () => {
    if (!codeValid || busy) return;
    setBusy(true);
    setError('');
    let res: Awaited<ReturnType<typeof window.clawwork.commercialVerifyOtp>>;
    try {
      res = await window.clawwork.commercialVerifyOtp(`+86${phone}`, code);
    } catch {
      // IPC 自己炸了 = 我们没拿到答案 ⇒ 属于"问不出来"，**不是**"你码错了"
      res = { ok: false, errorCode: 'otp_verify_unreachable' };
    }
    setBusy(false);
    if (!res.ok) {
      setError(describeVerifyError(res.errorCode));
      return;
    }
    setMascotPose('success');
    window.setTimeout(onSignedIn, 320);
  }, [busy, code, codeValid, describeVerifyError, onSignedIn, phone]);

  const onSubmitForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (phase === 'phone') void sendCode();
    else void submit();
  };

  const inputClass =
    'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-4 py-2.5 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-60';

  return (
    <div className="brand-first-run flex h-screen overflow-y-auto bg-[var(--surface-onboarding-page)] text-[var(--text-primary)] lg:overflow-hidden">
      <div className="titlebar-drag fixed top-0 left-0 right-0 h-8 z-50" />

      <section
        data-login-region="brand"
        className="relative hidden min-h-screen w-1/2 overflow-hidden border-r border-[var(--border)] bg-[var(--surface-onboarding-accent)] px-12 pb-10 pt-16 lg:flex lg:flex-col"
      >
        <div className="absolute -left-24 top-24 h-72 w-72 rounded-full bg-[var(--accent-dim)] opacity-70 blur-3xl" />
        <div className="absolute -right-24 bottom-10 h-64 w-64 rounded-full bg-[var(--danger-bg)] opacity-80 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <img src={logo} alt="" className="h-11 w-11 rounded-xl" />
          <div>
            <p className="type-section-title">{t('common.appName')}</p>
            <p className="type-support mt-0.5 text-[var(--text-onboarding-muted)]">AI USB Workspace</p>
          </div>
        </div>

        <div className="relative my-auto max-w-lg py-12">
          <h2 className="type-page-title max-w-md text-[var(--text-primary)]">{t('mainArea.welcomeTitle')}</h2>
          <p className="mt-3 max-w-md type-body leading-7 text-[var(--text-onboarding-muted)]">
            {t('assistantWorkspaces.compass.description')}
          </p>
          <div className="type-body mt-7 max-w-md border-t border-[var(--border)] pt-4 leading-6 text-[var(--text-onboarding-muted)]">
            {t('fileBrowser.workspaceAccessDescription')}
          </div>
        </div>

        <div data-guide-mascot className="relative mx-auto w-full max-w-sm">
          <GuideMascot pose={mascotPose} />
        </div>
      </section>

      <section
        data-login-region="form"
        className="flex min-h-screen flex-1 items-center justify-center px-6 py-14 sm:px-12"
      >
        <motion.div {...motionPresets.slideUp} className="w-full max-w-md space-y-8">
          <div data-guide-mascot className="mx-auto w-40 lg:hidden">
            <GuideMascot pose={mascotPose} />
          </div>
          <div className="flex flex-col items-center text-center space-y-3">
            <h1 className="type-section-title text-[var(--text-primary)]">
              {phase === 'phone' ? t('login.title') : t('login.codeTitle')}
            </h1>
            <p className="type-body leading-relaxed text-[var(--text-muted)]">
              {phase === 'phone' ? t('login.subtitle') : t('login.codeSubtitle', { phone })}
            </p>
          </div>

          <form
            onSubmit={onSubmitForm}
            className="space-y-4 rounded-2xl bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-elevated)] sm:p-6"
          >
            {phase === 'phone' ? (
              <div className="relative">
                <Phone size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <span className="absolute left-9 top-1/2 -translate-y-1/2 type-body text-[var(--text-muted)]">+86</span>
                <input
                  type="tel"
                  inputMode="numeric"
                  autoFocus
                  value={phone}
                  disabled={busy}
                  onChange={(e) => setPhone(normalizePhone(e.target.value))}
                  onFocus={() => setMascotPose('phone')}
                  onBlur={() => setMascotPose('idle')}
                  placeholder={t('login.phonePlaceholder')}
                  className={cn(inputClass, 'pl-18')}
                />
              </div>
            ) : (
              <div className="relative">
                <ShieldCheck
                  size={15}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                />
                <input
                  ref={codeInputRef}
                  type="text"
                  inputMode="numeric"
                  value={code}
                  disabled={busy}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onFocus={() => setMascotPose('covering')}
                  onBlur={() => setMascotPose('idle')}
                  placeholder={t('login.codePlaceholder')}
                  className={cn(inputClass, 'pl-10 tracking-[0.3em]')}
                />
              </div>
            )}

            {error && (
              <p className="type-support text-[var(--danger)]" role="alert">
                {error}
              </p>
            )}

            <Button
              data-primary-action
              type="submit"
              disabled={busy || !agreed || (phase === 'phone' ? !phoneValid : !codeValid)}
              className="brand-action w-full"
            >
              {busy ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <>
                  {phase === 'phone' ? t('login.sendCode') : t('login.signIn')}
                  <ArrowRight size={15} />
                </>
              )}
            </Button>

            <div className="grid grid-cols-2 gap-3 border-t border-[var(--border-subtle)] pt-4 type-support text-[var(--text-onboarding-muted)]">
              <span className="flex items-center gap-2">
                <HardDrive size={14} className="text-[var(--accent)]" />
                {t('dashboard.localScope')}
              </span>
              <span className="flex items-center gap-2">
                {phase === 'code' ? (
                  <CheckCircle2 size={14} className="text-[var(--accent)]" />
                ) : (
                  <Sparkles size={14} className="text-[var(--accent)]" />
                )}
                {t('dashboard.accountScope')}
              </span>
            </div>
          </form>

          <div className="flex flex-col items-center gap-2">
            <label className="flex items-start gap-2 type-support text-[var(--text-muted)] cursor-pointer">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              <AgreementLinks
                template={t('login.agreement')}
                termsLabel={t('login.termsOfService')}
                privacyLabel={t('login.privacyPolicy')}
                termsUrl={t('login.termsUrl')}
                privacyUrl={t('login.privacyUrl')}
              />
            </label>
            {phase === 'code' && (
              <div className="flex items-center justify-center gap-1 type-support text-[var(--text-muted)]">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPhase('phone');
                    setCode('');
                    setError('');
                  }}
                  className="rounded px-2 py-1 transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('login.changePhone')}
                </button>
                <span aria-hidden="true">·</span>
                {/* Always interactive while counting down: clicking surfaces the
                    remaining wait instead of a dead button the user will
                    repeatedly retry. */}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendCode()}
                  className="rounded px-2 py-1 transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {countdown > 0 ? t('login.resendIn', { seconds: countdown }) : t('login.resend')}
                </button>
              </div>
            )}
          </div>
        </motion.div>
      </section>
    </div>
  );
}
