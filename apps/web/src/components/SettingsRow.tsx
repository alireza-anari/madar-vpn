import type { ReactNode } from 'react';

type Props = {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
};

export function SettingsRow({ icon, title, description, action, children }: Props) {
  return (
    <section className="settings-row">
      <span className="settings-row__icon" aria-hidden="true">{icon}</span>
      <div className="settings-row__body">
        <h2 className="settings-row__title">{title}</h2>
        {description ? <div className="settings-row__description">{description}</div> : null}
        {children ? <div className="settings-row__content">{children}</div> : null}
      </div>
      {action ? <div className="settings-row__action">{action}</div> : null}
    </section>
  );
}
