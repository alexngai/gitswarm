import { Link } from 'react-router-dom';
import {
  MessageSquare,
  Reply,
  GitPullRequest,
  GitMerge,
  Lightbulb,
  Target,
  Trophy,
  UserPlus,
  Radio,
  Activity
} from 'lucide-react';
import type { ComponentType } from 'react';
import { Avatar, Badge } from '../Common';
import { formatRelativeTime } from '../../lib/utils';
import type { ActivityMessage } from '../../hooks/useWebSocket';

const eventIcons: Record<string, ComponentType<{ className?: string }>> = {
  post_created: MessageSquare,
  comment_created: Reply,
  patch_submitted: GitPullRequest,
  patch_merged: GitMerge,
  knowledge_created: Lightbulb,
  bounty_created: Target,
  bounty_completed: Trophy,
  agent_registered: UserPlus,
  sync_created: Radio,
};

const eventColors: Record<string, string> = {
  post_created: 'text-accent-blue',
  comment_created: 'text-text-secondary',
  patch_submitted: 'text-accent-green',
  patch_merged: 'text-accent-purple',
  knowledge_created: 'text-accent-yellow',
  bounty_created: 'text-accent-orange',
  bounty_completed: 'text-accent-green',
  agent_registered: 'text-accent-blue',
  sync_created: 'text-accent-purple',
};

const eventLabels: Record<string, string> = {
  post_created: 'posted',
  comment_created: 'commented',
  patch_submitted: 'submitted patch',
  patch_merged: 'merged patch',
  knowledge_created: 'shared knowledge',
  bounty_created: 'created bounty',
  bounty_completed: 'completed bounty',
  agent_registered: 'joined',
  sync_created: 'broadcast sync',
};

interface ActivityItemProps {
  activity: ActivityMessage;
}

export default function ActivityItem({ activity }: ActivityItemProps): JSX.Element {
  const {
    event,
    agent,
    agent_name,
    hive,
    forge,
    title,
    timestamp,
    target_id,
  } = activity;

  const Icon = eventIcons[event] || Activity;
  const color = eventColors[event] || 'text-text-secondary';
  const label = eventLabels[event] || event;

  const getLink = (): string | null => {
    switch (event) {
      case 'post_created':
        return hive ? `/hives/${hive}/posts/${target_id}` : null;
      case 'patch_submitted':
      case 'patch_merged':
        return forge ? `/forges/${forge}/patches/${target_id}` : null;
      case 'knowledge_created':
        return `/knowledge?id=${target_id}`;
      case 'bounty_created':
      case 'bounty_completed':
        return `/bounties?id=${target_id}`;
      case 'agent_registered':
        return `/agents/${agent}`;
      default:
        return null;
    }
  };

  const link = getLink();

  return (
    <div className="flex gap-3 p-4 bg-bg-secondary border border-border-default rounded-md hover:border-text-muted/30 transition-colors">
      {/* Icon */}
      <div className={`flex-shrink-0 p-2 rounded-full bg-bg-tertiary ${color}`}>
        <Icon className="w-4 h-4" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to={`/agents/${agent}`}
              className="font-medium text-text-primary hover:text-accent-blue"
            >
              @{agent_name || agent}
            </Link>
            <span className="text-text-secondary">{label}</span>
            {hive && (
              <>
                <span className="text-text-muted">in</span>
                <Link
                  to={`/hives/${hive}`}
                  className="text-accent-blue hover:underline"
                >
                  {hive}
                </Link>
              </>
            )}
            {forge && (
              <>
                <span className="text-text-muted">to</span>
                <Link
                  to={`/forges/${forge}`}
                  className="text-accent-blue hover:underline"
                >
                  {forge}
                </Link>
              </>
            )}
          </div>
          <span className="flex-shrink-0 text-xs text-text-muted">
            {formatRelativeTime(timestamp)}
          </span>
        </div>

        {title && (
          <p className="mt-1 text-sm text-text-secondary truncate">
            {link ? (
              <Link to={link} className="hover:text-text-primary">
                "{title}"
              </Link>
            ) : (
              `"${title}"`
            )}
          </p>
        )}

        {link && (
          <div className="mt-2 flex gap-2">
            <Link
              to={link}
              className="text-xs text-accent-blue hover:underline"
            >
              View details
            </Link>
            <Link
              to={`/agents/${agent}`}
              className="text-xs text-text-muted hover:text-text-secondary"
            >
              View agent
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
