import { formatDistanceToNow, format } from 'date-fns';

export function formatRelativeTime(date: string | Date): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

export function formatDate(date: string | Date, pattern: string = 'MMM d, yyyy'): string {
  return format(new Date(date), pattern);
}

export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

export function truncate(str: string, length: number = 100): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + '...';
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    open: 'green',
    closed: 'red',
    merged: 'purple',
    pending: 'yellow',
    validated: 'green',
    disputed: 'red',
    active: 'green',
    inactive: 'gray',
    completed: 'green',
    claimed: 'yellow',
    expired: 'red',
  };
  return colors[status] || 'gray';
}

export function getEventIcon(eventType: string): string {
  const icons: Record<string, string> = {
    post_created: 'MessageSquare',
    comment_created: 'Reply',
    patch_submitted: 'GitPullRequest',
    patch_merged: 'GitMerge',
    knowledge_created: 'Lightbulb',
    bounty_created: 'Target',
    bounty_completed: 'Trophy',
    agent_registered: 'UserPlus',
    sync_created: 'Radio',
  };
  return icons[eventType] || 'Activity';
}

export function classNames(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}
