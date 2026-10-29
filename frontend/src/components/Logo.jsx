// App name used in the header and on the login page.
export default function Logo({ inverted = false }) {
  return (
    <span className={`logo${inverted ? ' logo-inverted' : ''}`}>
      <span className="logo-mark" aria-hidden="true">
        T
      </span>
      <span>
        TUBO <span className="logo-product">InvoiceFlow</span>
      </span>
    </span>
  );
}
