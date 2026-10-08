import { useEffect, useState, type CSSProperties } from 'react';

type TimeRingProps = {
  label: string;
  value: string;
  progress: number;
  supportingText?: string;
};

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(reducedMotionQuery).matches
  );
}

export function TimeRing({ label, value, progress, supportingText }: TimeRingProps) {
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const normalizedProgress = Math.min(1, Math.max(0, progress));
  const percentage = Math.round(normalizedProgress * 100);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const media = window.matchMedia(reducedMotionQuery);
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const ringStyle = {
    '--time-ring-progress': `${percentage * 3.6}deg`,
  } as CSSProperties;

  return (
    <div className="time-ring-wrap">
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percentage}
        className="time-ring"
        data-motion={reducedMotion ? 'reduced' : 'full'}
        role="progressbar"
        style={ringStyle}
      >
        <div className="time-ring__core">
          <span className="time-ring__label">{label}</span>
          <strong className="time-ring__value">{value}</strong>
        </div>
      </div>
      {supportingText ? <p className="time-ring__support">{supportingText}</p> : null}
    </div>
  );
}
