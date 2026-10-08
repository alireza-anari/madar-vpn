import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: 'primary' | 'quiet';
};

export function Button({ children, className = '', variant = 'primary', type = 'button', ...props }: ButtonProps) {
  const classes = ['button', `button--${variant}`, className].filter(Boolean).join(' ');
  return (
    <button className={classes} type={type} {...props}>
      {children}
    </button>
  );
}
