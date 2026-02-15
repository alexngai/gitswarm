import { clsx } from 'clsx';
import type { CSSProperties } from 'react';

type SkeletonVariant = 'text' | 'title' | 'avatar' | 'card' | 'button' | 'badge';

interface SkeletonProps {
  className?: string;
  variant?: SkeletonVariant;
  width?: number | string;
  height?: number | string;
}

const variantClasses: Record<SkeletonVariant, string> = {
  text: 'h-4 w-full',
  title: 'h-6 w-3/4',
  avatar: 'rounded-full',
  card: 'h-24 w-full',
  button: 'h-10 w-24',
  badge: 'h-5 w-16 rounded-full',
};

/**
 * Skeleton loading placeholder component
 */
export function Skeleton({ className = '', variant = 'text', width, height }: SkeletonProps): JSX.Element {
  const baseClasses = 'animate-pulse bg-bg-tertiary rounded';

  const style: CSSProperties = {};
  if (width) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height) style.height = typeof height === 'number' ? `${height}px` : height;

  return (
    <div
      className={clsx(baseClasses, variantClasses[variant], className)}
      style={style}
    />
  );
}

interface SkeletonCardProps {
  className?: string;
}

/**
 * Skeleton card for agent/hive/forge cards
 */
export function SkeletonCard({ className = '' }: SkeletonCardProps): JSX.Element {
  return (
    <div className={clsx('bg-bg-secondary border border-border-default rounded-md p-4', className)}>
      <div className="flex items-start gap-4">
        <Skeleton variant="avatar" width={48} height={48} />
        <div className="flex-1 space-y-2">
          <Skeleton variant="title" />
          <Skeleton variant="text" width="60%" />
          <div className="flex gap-2 mt-3">
            <Skeleton variant="badge" />
            <Skeleton variant="badge" />
          </div>
        </div>
      </div>
    </div>
  );
}

interface SkeletonActivityItemProps {
  className?: string;
}

/**
 * Skeleton for activity feed items
 */
export function SkeletonActivityItem({ className = '' }: SkeletonActivityItemProps): JSX.Element {
  return (
    <div className={clsx('flex items-start gap-3 p-4 border-b border-border-default', className)}>
      <Skeleton variant="avatar" width={40} height={40} />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton variant="text" width={100} />
          <Skeleton variant="text" width={60} />
        </div>
        <Skeleton variant="text" width="80%" />
        <Skeleton variant="text" width="40%" />
      </div>
    </div>
  );
}

interface SkeletonStatCardProps {
  className?: string;
}

/**
 * Skeleton for stat cards
 */
export function SkeletonStatCard({ className = '' }: SkeletonStatCardProps): JSX.Element {
  return (
    <div className={clsx('bg-bg-secondary border border-border-default rounded-md p-4', className)}>
      <div className="flex items-center justify-between mb-3">
        <Skeleton variant="avatar" width={36} height={36} className="rounded-md" />
        <Skeleton variant="badge" width={50} />
      </div>
      <Skeleton variant="title" width={80} className="mb-1" />
      <Skeleton variant="text" width={100} />
    </div>
  );
}

interface SkeletonTableRowProps {
  columns?: number;
  className?: string;
}

/**
 * Skeleton for table rows
 */
export function SkeletonTableRow({ columns = 4, className = '' }: SkeletonTableRowProps): JSX.Element {
  return (
    <div className={clsx('flex items-center gap-4 p-3 border-b border-border-default', className)}>
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} variant="text" className="flex-1" />
      ))}
    </div>
  );
}

interface SkeletonListItemProps {
  className?: string;
}

/**
 * Skeleton for list items
 */
export function SkeletonListItem({ className = '' }: SkeletonListItemProps): JSX.Element {
  return (
    <div className={clsx('flex items-center gap-3 p-2', className)}>
      <Skeleton variant="avatar" width={32} height={32} />
      <div className="flex-1 space-y-1">
        <Skeleton variant="text" width="70%" />
        <Skeleton variant="text" width="40%" className="h-3" />
      </div>
    </div>
  );
}

interface SkeletonDetailProps {
  className?: string;
}

/**
 * Skeleton for post/content detail
 */
export function SkeletonDetail({ className = '' }: SkeletonDetailProps): JSX.Element {
  return (
    <div className={clsx('bg-bg-secondary border border-border-default rounded-md p-6', className)}>
      <div className="flex items-start gap-4 mb-6">
        <Skeleton variant="avatar" width={56} height={56} />
        <div className="flex-1 space-y-2">
          <Skeleton variant="title" />
          <div className="flex gap-2">
            <Skeleton variant="badge" />
            <Skeleton variant="badge" />
          </div>
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton variant="text" />
        <Skeleton variant="text" />
        <Skeleton variant="text" width="80%" />
        <Skeleton variant="text" width="60%" />
      </div>
    </div>
  );
}

export default Skeleton;
