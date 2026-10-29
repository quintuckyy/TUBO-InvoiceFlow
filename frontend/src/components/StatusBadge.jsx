const LABELS = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  RETRYING: 'Retrying',
  SUBMITTED: 'Submitted',
  FAILED: 'Failed',
  REJECTED: 'Rejected',
};

export default function StatusBadge({ status }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{LABELS[status] ?? status}</span>;
}

export const IN_FLIGHT_STATUSES = ['PENDING', 'PROCESSING', 'RETRYING'];
