import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import StatusBadge, { IN_FLIGHT_STATUSES } from '../components/StatusBadge.jsx';
import { formatDateTime, formatMoney } from '../format.js';

const POLL_MS = 3000;

const STATUS_HELP = {
  PENDING: 'Accepted by Tubo and queued for submission to the government.',
  PROCESSING: 'Currently being sent to the government API.',
  RETRYING: 'The government API had a temporary problem. Tubo will retry automatically.',
  SUBMITTED: 'Successfully registered with the government.',
  FAILED: 'Automatic retries were exhausted. You can retry manually.',
  REJECTED: 'The government rejected the invoice data. It must be corrected; retrying the same data will not help.',
};

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      setInvoice((await api.getInvoice(id)).data);
      setError(null);
    } catch (err) {
      setError(err.status === 404 ? 'Invoice not found.' : err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep polling while the invoice is still moving through the pipeline.
  const inFlight = invoice && IN_FLIGHT_STATUSES.includes(invoice.status);
  useEffect(() => {
    if (!inFlight) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  async function handleRetry() {
    setRetrying(true);
    setNotice(null);
    try {
      setInvoice((await api.retryInvoice(id)).data);
      setNotice('Invoice queued for another submission attempt.');
    } catch (err) {
      setNotice(err.message);
      load();
    } finally {
      setRetrying(false);
    }
  }

  if (error)
    return (
      <section>
        <div className="alert alert-error">{error}</div>
        <Link to="/invoices">‹ Back to invoices</Link>
      </section>
    );
  if (!invoice) return <p className="muted center">Loading…</p>;

  const { processing } = invoice;

  return (
    <section>
      <div className="page-header">
        <h2>
          Invoice {invoice.invoiceNumber} <StatusBadge status={invoice.status} />
        </h2>
        <Link to="/invoices">‹ Back to invoices</Link>
      </div>

      {notice && <div className="alert">{notice}</div>}

      <div className="card">
        <h3>Processing</h3>
        <p>{STATUS_HELP[invoice.status]}</p>
        <dl className="details">
          <dt>Attempts</dt>
          <dd>{processing.attemptCount}</dd>
          {processing.nextAttemptAt && (
            <>
              <dt>Next attempt</dt>
              <dd>{formatDateTime(processing.nextAttemptAt)}</dd>
            </>
          )}
          {processing.governmentReference && (
            <>
              <dt>Government reference</dt>
              <dd>
                <code>{processing.governmentReference}</code>
              </dd>
            </>
          )}
          {processing.submittedAt && (
            <>
              <dt>Submitted at</dt>
              <dd>{formatDateTime(processing.submittedAt)}</dd>
            </>
          )}
          {processing.lastError && (
            <>
              <dt>Last error</dt>
              <dd className="error-text">{processing.lastError}</dd>
            </>
          )}
        </dl>
        {invoice.canRetry && (
          <button className="primary" onClick={handleRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry submission'}
          </button>
        )}
      </div>

      <div className="card">
        <h3>Invoice information</h3>
        <dl className="details">
          <dt>Seller</dt>
          <dd>
            {invoice.seller.name} ({invoice.seller.taxId})
          </dd>
          <dt>Invoice date</dt>
          <dd>{invoice.invoiceDate}</dd>
          <dt>Customer</dt>
          <dd>{invoice.customerName}</dd>
          <dt>Customer tax ID</dt>
          <dd>{invoice.customerTaxId}</dd>
          <dt>Customer email</dt>
          <dd>{invoice.customerEmail}</dd>
          <dt>Created</dt>
          <dd>{formatDateTime(invoice.createdAt)}</dd>
        </dl>
      </div>

      <div className="card">
        <h3>Items</h3>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              <th className="num">Tax %</th>
              <th className="num">Tax</th>
              <th className="num">Line total</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item) => (
              <tr key={item.lineNumber}>
                <td>{item.lineNumber}</td>
                <td>{item.description}</td>
                <td className="num">{item.quantity}</td>
                <td className="num">{item.unitPrice}</td>
                <td className="num">{item.taxRate}</td>
                <td className="num">{item.taxAmount}</td>
                <td className="num">{item.lineTotal}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="totals">
          <dt>Subtotal</dt>
          <dd>{formatMoney(invoice.subtotal, invoice.currency)}</dd>
          <dt>Tax</dt>
          <dd>{formatMoney(invoice.taxAmount, invoice.currency)}</dd>
          <dt>Total</dt>
          <dd>
            <strong>{formatMoney(invoice.totalAmount, invoice.currency)}</strong>
          </dd>
        </dl>
      </div>

      <div className="card">
        <h3>Submission history</h3>
        {invoice.attempts.length === 0 ? (
          <p className="muted">No attempts yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Outcome</th>
                <th>HTTP</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {invoice.attempts.map((a) => (
                <tr key={a.attemptNumber}>
                  <td>{a.attemptNumber}</td>
                  <td>{formatDateTime(a.startedAt)}</td>
                  <td>
                    {formatDateTime(a.finishedAt)}
                    {a.durationMs != null && <span className="muted"> ({a.durationMs} ms)</span>}
                  </td>
                  <td>
                    <code>{a.outcome}</code>
                  </td>
                  <td>{a.httpStatus ?? '—'}</td>
                  <td className="error-text">{a.errorMessage ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
