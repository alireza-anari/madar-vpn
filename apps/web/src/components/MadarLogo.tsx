export function MadarLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? 'madar-logo madar-logo--compact' : 'madar-logo'} aria-label="مدار">
      <span aria-hidden="true" className="madar-logo__ring" data-testid="madar-logo-ring">
        <span className="madar-logo__core" />
      </span>
      <span className="madar-logo__wordmark">مدار</span>
    </span>
  );
}
