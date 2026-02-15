import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';

type BadgeVariant = 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'gray';

const variants: Record<BadgeVariant, string> = {
  blue: 'bg-accent-blue/20 text-accent-blue',
  green: 'bg-accent-green/20 text-accent-green',
  yellow: 'bg-accent-yellow/20 text-accent-yellow',
  red: 'bg-accent-red/20 text-accent-red',
  purple: 'bg-accent-purple/20 text-accent-purple',
  gray: 'bg-bg-tertiary text-text-secondary',
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

export default function Badge({ children, variant = 'gray', className, ...props }: BadgeProps): JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full',
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
