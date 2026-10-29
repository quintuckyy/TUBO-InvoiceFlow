import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import Logo from '../components/Logo.jsx';

// Seeded accounts (see backend/src/db/seed.js), shown so reviewers can sign in with one click.
const DEMO_PASSWORD = 'Password123!';
const DEMO_ACCOUNTS = [
  { email: 'usera@abc.test', name: 'User A', company: 'ABC Corporation' },
  { email: 'userb@beta.test', name: 'User B', company: 'Beta Trading Ltd' },
];

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/invoices" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(location.state?.from ?? '/invoices', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function fillDemoAccount(account) {
    setEmail(account.email);
    setPassword(DEMO_PASSWORD);
    setError(null);
  }

  return (
    <div className="login">
      <div className="login-frame">
        <section className="login-hero">
          <Logo inverted />

          <div className="login-hero-body">
            <span className="login-pill">E-invoicing for businesses</span>
            <h1>Every invoice delivered, exactly once.</h1>
            <p>Create invoices in seconds. TUBO handles the government submission, retries and record-keeping for you.</p>
          </div>
        </section>

        <section className="login-panel">
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-heading">
              <h2>Welcome back</h2>
              <p className="muted">Sign in to manage your company&apos;s invoices.</p>
            </div>

            {error && (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            )}

            <label htmlFor="login-email">
              Email
              <input
                id="login-email"
                className="soft-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoComplete="username"
                autoFocus
              />
            </label>

            <label htmlFor="login-password">
              Password
              <span className="password-field">
                <input
                  id="login-password"
                  className="soft-input"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="link password-toggle"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>

            <button type="submit" className="primary login-submit" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>

            <div className="divider">
              <span>or try a demo account</span>
            </div>

            <div className="demo-accounts">
              {DEMO_ACCOUNTS.map((account) => (
                <button key={account.email} type="button" className="demo-account" onClick={() => fillDemoAccount(account)}>
                  <span className="demo-avatar" aria-hidden="true">
                    {account.name.slice(-1)}
                  </span>
                  <span className="demo-details">
                    <strong>{account.company}</strong>
                    <span className="muted">{account.email}</span>
                  </span>
                </button>
              ))}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
