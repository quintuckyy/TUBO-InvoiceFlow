import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

const newItem = () => ({ key: crypto.randomUUID(), description: '', quantity: '1', unitPrice: '', taxRate: '0' });

const initialForm = () => ({
  invoiceNumber: '',
  invoiceDate: new Date().toISOString().slice(0, 10),
  customerName: '',
  customerTaxId: '',
  customerEmail: '',
  currency: 'USD',
  items: [newItem()],
});

const isNonNegativeNumber = (value, maxDecimals) => new RegExp(`^\\d+(\\.\\d{1,${maxDecimals}})?$`).test(value.trim());

/**
 * Client-side validation gives instant feedback. It is a convenience only:
 * the server validates everything again and is the source of truth.
 * Error keys use the same paths as the API ("items.0.quantity"), so both display the same way.
 */
function validateForm(form) {
  const errors = {};
  if (!form.invoiceNumber.trim()) errors.invoiceNumber = 'Invoice number is required';
  if (!form.invoiceDate) errors.invoiceDate = 'Invoice date is required';
  if (!form.customerName.trim()) errors.customerName = 'Customer name is required';
  if (!form.customerTaxId.trim()) errors.customerTaxId = 'Customer tax ID is required';
  if (!/^\S+@\S+\.\S+$/.test(form.customerEmail.trim())) errors.customerEmail = 'Enter a valid email address';
  if (!/^[A-Za-z]{3}$/.test(form.currency.trim())) errors.currency = 'Use a 3-letter currency code';
  if (form.items.length === 0) errors.items = 'Add at least one item';

  form.items.forEach((item, i) => {
    if (!item.description.trim()) errors[`items.${i}.description`] = 'Required';
    if (!isNonNegativeNumber(item.quantity, 3) || Number(item.quantity) <= 0)
      errors[`items.${i}.quantity`] = 'Must be > 0';
    if (!isNonNegativeNumber(item.unitPrice, 2)) errors[`items.${i}.unitPrice`] = 'Invalid price';
    if (!isNonNegativeNumber(item.taxRate, 2) || Number(item.taxRate) > 100)
      errors[`items.${i}.taxRate`] = '0 – 100';
  });
  return errors;
}

// Display-only estimate; the server calculates the authoritative totals.
function estimateTotals(items) {
  let subtotal = 0;
  let tax = 0;
  for (const item of items) {
    const line = Math.round((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0) * 100) / 100;
    subtotal += line;
    tax += Math.round(line * (Number(item.taxRate) || 0)) / 100;
  }
  return { subtotal, tax, total: subtotal + tax };
}

export default function CreateInvoicePage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [duplicateId, setDuplicateId] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = (name, value) => setForm((f) => ({ ...f, [name]: value }));
  const setItemField = (key, name, value) =>
    setForm((f) => ({ ...f, items: f.items.map((it) => (it.key === key ? { ...it, [name]: value } : it)) }));
  const addItem = () => setForm((f) => ({ ...f, items: [...f.items, newItem()] }));
  const removeItem = (key) => setForm((f) => ({ ...f, items: f.items.filter((it) => it.key !== key) }));

  async function handleSubmit(event) {
    event.preventDefault();
    setFormError(null);
    setDuplicateId(null);

    const clientErrors = validateForm(form);
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) {
      setFormError('Please fix the highlighted fields.');
      return;
    }

    setSubmitting(true); // also prevents double-submits from repeated clicks
    try {
      // Strip the client-only React "key" from each item; the API rejects unknown fields.
      const payload = { ...form, items: form.items.map(({ key: _key, ...item }) => item) };
      const res = await api.createInvoice(payload);
      navigate(`/invoices/${res.data.id}`);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
        setErrors(Object.fromEntries(err.details.map((d) => [d.path || '_form', d.message])));
        setFormError('The server rejected some fields.');
      } else if (err.code === 'DUPLICATE_INVOICE') {
        setErrors({ invoiceNumber: 'This invoice number already exists' });
        setDuplicateId(err.details?.existingInvoiceId);
        setFormError(err.message);
      } else {
        setFormError(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const totals = estimateTotals(form.items);
  const field = (name, label, props = {}) => (
    <label>
      {label}
      <input
        value={form[name]}
        onChange={(e) => setField(name, e.target.value)}
        aria-invalid={Boolean(errors[name])}
        {...props}
      />
      {errors[name] && <span className="field-error">{errors[name]}</span>}
    </label>
  );

  return (
    <section>
      <div className="page-header">
        <h2>New invoice</h2>
        <Link to="/invoices">‹ Back to invoices</Link>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        {formError && (
          <div className="alert alert-error">
            {formError}{' '}
            {duplicateId && <Link to={`/invoices/${duplicateId}`}>View existing invoice</Link>}
            {errors._form && <div>{errors._form}</div>}
          </div>
        )}

        <div className="card">
          <h3>Invoice</h3>
          <div className="grid">
            {field('invoiceNumber', 'Invoice number', { placeholder: 'INV-10001' })}
            {field('invoiceDate', 'Invoice date', { type: 'date' })}
            {field('currency', 'Currency', { maxLength: 3 })}
          </div>
          <h3>Customer</h3>
          <div className="grid">
            {field('customerName', 'Name')}
            {field('customerTaxId', 'Tax ID')}
            {field('customerEmail', 'Email', { type: 'email' })}
          </div>
        </div>

        <div className="card">
          <h3>Items</h3>
          {errors.items && <div className="field-error">{errors.items}</div>}
          <table className="items">
            <thead>
              <tr>
                <th>Description</th>
                <th className="num">Quantity</th>
                <th className="num">Unit price</th>
                <th className="num">Tax %</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {form.items.map((item, i) => (
                <tr key={item.key}>
                  {['description', 'quantity', 'unitPrice', 'taxRate'].map((name) => (
                    <td key={name}>
                      <input
                        value={item[name]}
                        inputMode={name === 'description' ? 'text' : 'decimal'}
                        aria-label={`Item ${i + 1} ${name}`}
                        aria-invalid={Boolean(errors[`items.${i}.${name}`])}
                        onChange={(e) => setItemField(item.key, name, e.target.value)}
                      />
                      {errors[`items.${i}.${name}`] && (
                        <span className="field-error">{errors[`items.${i}.${name}`]}</span>
                      )}
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => removeItem(item.key)}
                      disabled={form.items.length === 1}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={addItem}>
            + Add item
          </button>

          <dl className="totals">
            <dt>Subtotal</dt>
            <dd>{totals.subtotal.toFixed(2)}</dd>
            <dt>Tax</dt>
            <dd>{totals.tax.toFixed(2)}</dd>
            <dt>Total (estimate)</dt>
            <dd>
              <strong>
                {form.currency.toUpperCase()} {totals.total.toFixed(2)}
              </strong>
            </dd>
          </dl>
        </div>

        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Create invoice'}
        </button>
      </form>
    </section>
  );
}
