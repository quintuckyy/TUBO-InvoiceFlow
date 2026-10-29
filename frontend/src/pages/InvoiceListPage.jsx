import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { formatMoney } from '../format.js';

const STATUS_TABS = [
  { value: '', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'RETRYING', label: 'Retrying' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'REJECTED', label: 'Rejected' },
];
const EMPTY_FILTERS = { status: '', invoiceNumber: '', dateFrom: '', dateTo: '' };
const PAGE_SIZE = 20;
const REFRESH_MS = 5000;

export default function InvoiceListPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retryingId, setRetryingId] = useState(null);

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

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function retry(event, invoice) {
    event.stopPropagation(); // the row itself is clickable
    setRetryingId(invoice.id);
    setNotice(null);
    try {
      await api.retryInvoice(invoice.id);
      setNotice({ type: 'success', text: `${invoice.invoiceNumber} was queued for another submission attempt.` });
      await load();
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    } finally {
      setRetryingId(null);
    }
  }

  const hasFilters = Object.values(filters).some(Boolean);
  const pagination = result?.pagination;
  const firstRow = pagination && pagination.total > 0 ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const lastRow = pagination ? Math.min(pagination.page * pagination.pageSize, pagination.total) : 0;

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h2>Invoices</h2>
          <p className="muted">Track every invoice from creation to government registration.</p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
          <Link to="/invoices/new" className="button primary">
            + New invoice
          </Link>
        </div>
      </div>

      {notice && (
        <div className={`alert ${notice.type === 'error' ? 'alert-error' : 'alert-success'}`} role="status">
          {notice.text}
        </div>
      )}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="table-card">
        <div className="tabs" role="tablist" aria-label="Filter by status">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={filters.status === tab.value}
              className={`tab${filters.status === tab.value ? ' active' : ''}`}
              onClick={() => updateFilter('status', tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="toolbar">
          <input
            id="filter-invoice-number"
            className="search-input"
            type="search"
            placeholder="Search invoice number"
            aria-label="Search invoice number"
            value={filters.invoiceNumber}
            onChange={(e) => updateFilter('invoiceNumber', e.target.value)}
          />
          <label className="inline" htmlFor="filter-date-from">
            From
            <input id="filter-date-from" type="date" value={filters.dateFrom} onChange={(e) => updateFilter('dateFrom', e.target.value)} />
          </label>
          <label className="inline" htmlFor="filter-date-to">
            To
            <input id="filter-date-to" type="date" value={filters.dateTo} onChange={(e) => updateFilter('dateTo', e.target.value)} />
          </label>
          {hasFilters && (
            <button type="button" className="link" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>

        <div className="table-scroll">
          <table className="invoice-table">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Customer</th>
                <th>Date</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th className="num">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!result && (
                <tr>
                  <td colSpan={6} className="muted center">
                    Loading invoices…
                  </td>
                </tr>
              )}
              {result?.data.map((invoice) => (
                <tr key={invoice.id} className="clickable" onClick={() => navigate(`/invoices/${invoice.id}`)}>
                  <td>
                    <Link to={`/invoices/${invoice.id}`} className="cell-primary" onClick={(e) => e.stopPropagation()}>
                      {invoice.invoiceNumber}
                    </Link>
                  </td>
                  <td>
                    {invoice.customerName}
                    <span className="cell-sub">{invoice.customerEmail}</span>
                  </td>
                  <td className="nowrap">{invoice.invoiceDate}</td>
                  <td className="num nowrap">{formatMoney(invoice.totalAmount, invoice.currency)}</td>
                  <td>
                    <StatusBadge status={invoice.status} />
                  </td>
                  <td>
                    <div className="row-actions">
                      {invoice.canRetry && (
                        <button
                          type="button"
                          className="btn-sm primary"
                          onClick={(e) => retry(e, invoice)}
                          disabled={retryingId === invoice.id}
                        >
                          {retryingId === invoice.id ? 'Retrying…' : 'Retry'}
                        </button>
                      )}
                      <Link to={`/invoices/${invoice.id}`} className="button btn-sm" onClick={(e) => e.stopPropagation()}>
                        View
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {result?.data.length === 0 && (
          <div className="empty-state">
            <strong>{hasFilters ? 'No invoices match these filters' : 'No invoices yet'}</strong>
            <p className="muted">
              {hasFilters ? 'Try a different status, number or date range.' : 'Create your first invoice to send it to the government.'}
            </p>
            {hasFilters ? (
              <button type="button" onClick={clearFilters}>
                Clear filters
              </button>
            ) : (
              <Link to="/invoices/new" className="button primary">
                + New invoice
              </Link>
            )}
          </div>
        )}

        {pagination && pagination.total > 0 && (
          <div className="table-footer">
            <span className="muted">
              Showing {firstRow}–{lastRow} of {pagination.total}
            </span>
            <div className="header-actions">
              <button type="button" className="btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                ‹ Previous
              </button>
              <button
                type="button"
                className="btn-sm"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next ›
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
