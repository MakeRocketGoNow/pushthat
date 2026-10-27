import clsx from 'clsx';
import { FirebaseError } from 'firebase/app';
import { sendPasswordResetEmail } from 'firebase/auth';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';

import Button from '@/components/Button';
import GlowButton from '@/components/GlowButton';
import { auth } from '@/config/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { useKeys } from '@/contexts/KeysContext';
import { resetActionCodeSettings } from '@/services/passwordReset';
import { MIN_PASSWORD_LENGTH, WrongPasswordError } from '@/services/signIn';

import styles from './Login.module.css';

// docs/e2ee.md, What it protects: the sign-up asks for at least 10 characters and says why.
const PASSWORD_RULE = `Use at least ${MIN_PASSWORD_LENGTH} characters. Your password is the key to your pushes, so it has to be hard to guess.`;

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'signIn' | 'register' | undefined>();
  const [isResetMode, setIsResetMode] = useState(false);
  const [isResetEmailSent, setIsResetEmailSent] = useState(false);
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const keys = useKeys();

  // A sign-in or registration that gets as far as Firebase flips the site to its authed
  // frame, which remounts this page; the key steps it has left go on behind the route
  // guard (KeyGate), so this page only has to step aside.
  if (isAuthenticated) return <Navigate to="/links" replace />;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy('signIn');
    setError('');
    try {
      await keys.signIn(email, password);
      navigate('/links');
    } catch (error) {
      setError(
        error instanceof WrongPasswordError ||
          (error instanceof FirebaseError &&
            (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-email'))
          ? 'The email or password is not right.'
          : 'Failed to login'
      );
    } finally {
      setBusy(undefined);
    }
  };

  const handleRegister = async () => {
    if (busy) return;
    if (!email || !password) {
      setError('Please enter an email and password');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(PASSWORD_RULE);
      return;
    }

    setBusy('register');
    setError('');
    try {
      // The account, its user document and its keys; the recovery key is shown next.
      await keys.register(email, password);
      navigate('/links');
    } catch (error) {
      // Handle specific Firebase auth errors
      if (error instanceof FirebaseError) {
        if (error.code === 'auth/email-already-in-use') {
          setError('An account with this email already exists');
        } else if (error.code === 'auth/invalid-email') {
          setError('Invalid email address');
        } else {
          setError('Failed to create account');
        }
      } else {
        setError('Failed to create account');
      }
    } finally {
      setBusy(undefined);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email) {
      setError('Please enter an email address');
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email, resetActionCodeSettings);
      setIsResetEmailSent(true);
    } catch (error) {
      setError('Failed to send reset email');
    }
  };

  return (
    <div className={styles.loginContainer}>
      <div className={styles.loginBox}>
        <div className={styles.loginLogo}>
          <img src="/pushthat.svg" alt="PushThat Icon" className={styles.loginIcon} />
        </div>
        {!isResetMode || !isResetEmailSent ? (
          <>
            <div className={styles.loginHeader}>
              <h2 className={styles.loginTitle}>Sign in to PushThat</h2>
            </div>
            <form className={styles.loginForm} onSubmit={isResetMode ? handleResetPassword : handleLogin}>
              {error && <div className={styles.formError}>{error}</div>}
              <div className={styles.inputGroup}>
                <input
                  autoFocus
                  type="email"
                  required
                  className={styles.formInput}
                  placeholder="Email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                {!isResetMode && (
                  <input
                    type="password"
                    required
                    className={styles.formInput}
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </div>
              {!isResetMode ? (
                <>
                  <div className={styles.forgotPasswordContainer}>
                    <button type="button" className={styles.forgotPassword} onClick={() => setIsResetMode(true)}>
                      Forgot your password?
                    </button>
                  </div>
                  <GlowButton type="submit" className={styles.submitButton} disabled={!!busy}>
                    {busy === 'signIn' ? 'Signing in…' : 'Sign in'}
                  </GlowButton>
                  <p className={styles.passwordRule}>New here? {PASSWORD_RULE}</p>
                  <Button
                    type="button"
                    className={clsx(styles.submitButton, styles.registerButton)}
                    isSubmitting={!!busy}
                    onClick={handleRegister}
                  >
                    {busy === 'register' ? 'Creating your account…' : 'Register'}
                  </Button>
                </>
              ) : (
                <>
                  <Button type="submit" className={clsx(styles.submitButton, styles.resetButton)}>
                    Reset Password
                  </Button>
                  <div className={styles.backToLoginContainer}>
                    <a className={styles.backToLogin} href="/login" onClick={() => setIsResetMode(false)}>
                      Back to Login
                    </a>
                  </div>
                </>
              )}
            </form>
          </>
        ) : (
          <div className={styles.resetEmailSent}>
            <h2 className={styles.resetTitle}>Check your email</h2>
            <p className={styles.resetMessage}>
              Thanks! If <strong>{email}</strong> matches an email we have on file, then we've sent you an email
              containing further instructions for resetting your password.
            </p>
            <p className={styles.resetHelp}>
              If you haven't received an email in 5 minutes, check your spam, resend, or try a different email.
            </p>
            <div className={styles.backToLoginContainer}>
              <a
                className={styles.backToLogin}
                href="/login"
                onClick={() => {
                  setIsResetMode(false);
                  setIsResetEmailSent(false);
                }}
              >
                Back to Login
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
