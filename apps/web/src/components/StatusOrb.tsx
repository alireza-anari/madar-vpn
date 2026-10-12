type StatusOrbTone = 'positive' | 'neutral' | 'warning' | 'unavailable';

export function StatusOrb({
  label,
  value,
  tone,
  supportingText,
}: {
  label: string;
  value: string;
  tone: StatusOrbTone;
  supportingText?: string;
}) {
  return (
    <div className={`status-orb status-orb--${tone}`} role="group" aria-label={`${label}: ${value}`}>
      <div aria-hidden="true" className="status-orb__visual">
        <span className="status-orb__halo" />
        <span className="status-orb__inner" />
      </div>
      <div className="status-orb__copy">
        <span className="status-orb__label">{label}</span>
        <strong className="status-orb__value">{value}</strong>
        {supportingText ? <p className="status-orb__support">{supportingText}</p> : null}
      </div>
    </div>
  );
}
