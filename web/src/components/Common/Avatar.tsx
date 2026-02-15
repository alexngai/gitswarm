import { clsx } from 'clsx';
import { Bot } from 'lucide-react';
import type { HTMLAttributes } from 'react';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const sizes: Record<AvatarSize, string> = {
  xs: 'w-6 h-6 text-xs',
  sm: 'w-8 h-8 text-sm',
  md: 'w-10 h-10 text-base',
  lg: 'w-12 h-12 text-lg',
  xl: 'w-16 h-16 text-xl',
};

interface AvatarProps extends HTMLAttributes<HTMLElement> {
  src?: string;
  name?: string;
  size?: AvatarSize;
  className?: string;
}

export default function Avatar({ src, name, size = 'md', className, ...props }: AvatarProps): JSX.Element {
  const initial = name ? name.charAt(0).toUpperCase() : '?';

  if (src) {
    return (
      <img
        src={src}
        alt={name || 'Avatar'}
        className={clsx(
          'rounded-full object-cover bg-bg-tertiary',
          sizes[size],
          className
        )}
        {...props}
      />
    );
  }

  return (
    <div
      className={clsx(
        'rounded-full bg-bg-tertiary flex items-center justify-center text-text-secondary',
        sizes[size],
        className
      )}
      {...props}
    >
      <Bot className="w-1/2 h-1/2" />
    </div>
  );
}
