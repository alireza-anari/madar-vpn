type NavItem = {
  href: string;
  label: string;
  icon: 'home' | 'access' | 'premium' | 'missions' | 'settings';
};

const items: NavItem[] = [
  { href: '/', label: 'خانه', icon: 'home' },
  { href: '/access', label: 'دسترسی', icon: 'access' },
  { href: '/premium', label: 'اشتراک‌ها', icon: 'premium' },
  { href: '/missions', label: 'ماموریت‌ها', icon: 'missions' },
  { href: '/settings', label: 'تنظیمات', icon: 'settings' },
];

function NavIcon({ kind }: { kind: NavItem['icon'] }) {
  if (kind === 'home') {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5v8a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>;
  }
  if (kind === 'access') {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="6" rx="2" /><rect x="4" y="14" width="16" height="6" rx="2" /><path d="M8 7h.01M8 17h.01" /></svg>;
  }
  if (kind === 'premium') {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 8 4 4 4-7 4 7 4-4-2 11H6z" /></svg>;
  }
  if (kind === 'missions') {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M8 9h8M8 13h5" /></svg>;
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7-.6-1.4.9-1.9-2.1-2.1-1.9.9-1.4-.6-.7-2h-3l-.7 2-1.4.6-1.9-.9-2.1 2.1.9 1.9-.6 1.4-2 .7v3l2 .7.6 1.4-.9 1.9 2.1 2.1 1.9-.9 1.4.6.7 2h3l.7-2 1.4-.6 1.9.9 2.1-2.1-.9-1.9.6-1.4z" /></svg>;
}

export function BottomNav({ currentPath }: { currentPath: string }) {
  return (
    <nav aria-label="ناوبری اصلی" className="bottom-nav">
      {items.map((item) => {
        const active = currentPath === item.href;
        return (
          <a
            className="bottom-nav__link"
            href={item.href}
            key={item.href}
            aria-current={active ? 'page' : undefined}
          >
            <span className="bottom-nav__icon"><NavIcon kind={item.icon} /></span>
            <span className="bottom-nav__label">{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
