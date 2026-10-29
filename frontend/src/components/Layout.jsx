import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import Logo from './Logo.jsx';

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <>
      <header className="topbar">
        <Link to="/invoices" className="brand" aria-label="TUBO InvoiceFlow home">
          <Logo />
        </Link>
        <nav className="topnav">
          <NavLink to="/invoices" end>
            Invoices
          </NavLink>
          <NavLink to="/invoices/new" end>
            New invoice
          </NavLink>
        </nav>
        <div className="user">
          <span className="user-avatar" aria-hidden="true">
            {user.fullName.slice(-1)}
          </span>
          <span className="user-name">
            <strong>{user.fullName}</strong>
            <span className="muted">{user.company.name}</span>
          </span>
          <button type="button" className="btn-sm" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
