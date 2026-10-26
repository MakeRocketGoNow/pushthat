import clsx from 'clsx';
import { FirebaseError } from 'firebase/app';
import { createUserWithEmailAndPassword, sendPasswordResetEmail, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getFirestore, setDoc } from 'firebase/firestore';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import Button from '@/components/Button';
import GlowButton from '@/components/GlowButton';
import { auth } from '@/config/firebase';

import styles from './Login.module.css';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isResetMode, setIsResetMode] = useState(false);
  const [isResetEmailSent, setIsResetEmailSent] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, email, password);
      navigate('/links');
    } catch (error) {
      setError('Failed to login');
    }
  };

  const handleRegister = async () => {
    if (!email || !password) {
      setError('Please enter an email and password');
      return;
    }

    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);

      // Save user data to Firestore. The Chrome extension sees the new sign-in too and can
      // create the document first with its device token, and then the rules refuse this
      // write; the account exists either way, so that is not a failed sign-up.
      const db = getFirestore();
      try {
        await setDoc(doc(db, 'users', userCredential.user.uid), {
          email,
          createdAt: new Date(),
        });
      } catch (error) {
        if (!(error instanceof FirebaseError && error.code === 'permission-denied')) throw error;
      }

      // After successful registration and data save, navigate to links
      navigate('/links');
    } catch (error) {
      // Handle specific Firebase auth errors
      if (error instanceof FirebaseError) {
        if (error.code === 'auth/email-already-in-use') {
          setError('An account with this email already exists');
        } else if (error.code === 'auth/weak-password') {
          setError('Password should be at least 6 characters');
        } else if (error.code === 'auth/invalid-email') {
          setError('Invalid email address');
        } else {
          setError('Failed to create account');
        }
      } else {
        setError('Failed to create account');
      }
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email) {
      setError('Please enter an email address');
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);
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
                  <GlowButton type="submit" className={styles.submitButton}>
                    Sign in
                  </GlowButton>
                  <Button
                    type="button"
                    className={clsx(styles.submitButton, styles.registerButton)}
                    onClick={handleRegister}
                  >
                    Register
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
