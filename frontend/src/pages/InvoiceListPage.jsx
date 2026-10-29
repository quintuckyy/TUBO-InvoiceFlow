import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { formatMoney } from '../format.js';

const STATUSES = ['PENDING', 'PROCESSING', 'RETRYING', 'SUBMITTED', 'FAILED', 'REJECTED'];
const PAGE_SIZE = 20;
const REFRESH_MS = 5000;

export default function InvoiceListPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ status: '', invoiceNumber: '', dateFrom: '', dateTo: '' });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setResult(await api.listInvoices({ ...filters, page, pageSize: PAGE_SIZE }));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [filters, page]);

  // Load now, then refresh periodically so statuses update as the worker processes invoices.
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  function updateFilter(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
    setPage(1);
  }

  const pagination = result?.pagination;

  return (
    <section>
      <div className="page-header">
        <h2>Invoices</h2>
        <Link to="/invoices/new" className="button primary">
          + New invoice
        </Link>
      </div>

      <div className="filters">
        <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          placeholder="Invoice number"
          value={filters.invoiceNumber}
          onChange={(e) => updateFilter('invoiceNumber', e.target.value)}
        />
        <label className="inline">
          From <input type="date" value={filters.dateFrom} onChange={(e) => updateFilter('dateFrom', e.target.value)} />
        </label>
        <label className="inline">
          To <input type="date" value={filters.dateTo} onChange={(e) => updateFilter('dateTo', e.target.value)} />
        </label>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <table>
        <thead>
          <tr>
            <th>Invoice #</th>
            <th>Customer</th>
            <th>Date</th>
            <th className="num">Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {!result && (
            <tr>
              <td colSpan={5} className="muted center">
                Loading…
              </td>
            </tr>
          )}
          {result?.data.length === 0 && (
            <tr>
              <td colSpan={5} className="muted center">
                No invoices found
              </td>
            </tr>
          )}
          {result?.data.map((invoice) => (
            <tr key={invoice.id} className="clickable" onClick={() => navigate(`/invoices/${invoice.id}`)}>
              <td>
                <Link to={`/invoices/${invoice.id}`}>{invoice.invoiceNumber}</Link>
              </td>
              <td>{invoice.customerName}</td>
              <td>{invoice.invoiceDate}</td>
              <td className="num">{formatMoney(invoice.totalAmount, invoice.currency)}</td>
              <td>
                <StatusBadge status={invoice.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {pagination && pagination.totalPages > 1 && (
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹ Previous
          </button>
          <span className="muted">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} invoices)
          </span>
          <button disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>
            Next ›
          </button>
        </div>
      )}
    </section>
  );
}
