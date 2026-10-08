type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
};

export function PageHeader({ eyebrow, title, description }: PageHeaderProps) {
  return (
    <header className="page-header">
      {eyebrow ? <p className="page-header__eyebrow">{eyebrow}</p> : null}
      <h2 className="page-header__title">{title}</h2>
      {description ? <p className="page-header__description">{description}</p> : null}
    </header>
  );
}
