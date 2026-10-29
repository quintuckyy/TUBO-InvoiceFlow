import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <>
      <header className="topbar">
        <Link to="/invoices" className="brand">
          Tubo
        </Link>
        <nav>
          <Link to="/invoices">Invoices</Link>
          <Link to="/invoices/new">New invoice</Link>
        </nav>
        <div className="user">
          <span className="muted">
            {user.fullName} · {user.company.name}
          </span>
          <button
            className="link"
            onClick={() => {
              logout();
              navigate('/login');
            }}
          >
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
