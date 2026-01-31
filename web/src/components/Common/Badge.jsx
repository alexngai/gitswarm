import { clsx } from 'clsx';

const variants = {
  blue: 'bg-accent-blue/20 text-accent-blue',
  green: 'bg-accent-green/20 text-accent-green',
  yellow: 'bg-accent-yellow/20 text-accent-yellow',
  red: 'bg-accent-red/20 text-accent-red',
  purple: 'bg-accent-purple/20 text-accent-purple',
  gray: 'bg-bg-tertiary text-text-secondary',
};

export default function Badge({ children, variant = 'gray', className, ...props }) {
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
