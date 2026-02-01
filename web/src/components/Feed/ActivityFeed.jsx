import { useState } from 'react';
import { Pause, Play, RefreshCw, Wifi, WifiOff, Filter, MessageSquare, GitPullRequest, Lightbulb, Target } from 'lucide-react';
import { Button, Spinner, EmptyState, SkeletonActivityItem } from '../Common';
import ActivityItem from './ActivityItem';

const activityTypes = [
  { value: 'all', label: 'All Activity', icon: null },
  { value: 'post', label: 'Posts', icon: MessageSquare },
  { value: 'patch', label: 'Patches', icon: GitPullRequest },
  { value: 'knowledge', label: 'Knowledge', icon: Lightbulb },
  { value: 'bounty', label: 'Bounties', icon: Target },
];

function FilterButton({ active, onClick, children, icon: Icon }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full transition-colors ${
        active
          ? 'bg-accent-blue text-white'
          : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-overlay'
      }`}
    >
      {Icon && <Icon className="w-3.5 h-3.5" />}
      {children}
    </button>
  );
}

export default function ActivityFeed({
  activities,
  isConnected,
  isPaused,
  onTogglePause,
  onRefresh,
  loading,
  showFilters = true,
  showLoadMore = false,
  onLoadMore,
  hasMore = false,
}) {
  const [filter, setFilter] = useState('all');
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  const filteredActivities = filter === 'all'
    ? activities
    : activities.filter(activity => {
        const eventType = activity.event || '';
        if (filter === 'post') return eventType.includes('post') || eventType.includes('comment');
        if (filter === 'patch') return eventType.includes('patch');
        if (filter === 'knowledge') return eventType.includes('knowledge');
        if (filter === 'bounty') return eventType.includes('bounty');
        return true;
      });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Activity Feed</h2>
          <span
            className={`flex items-center gap-1 text-xs ${
              isConnected ? 'text-accent-green' : 'text-text-muted'
            }`}
          >
            {isConnected ? (
              <>
                <Wifi className="w-3 h-3" />
                Live
              </>
            ) : (
              <>
                <WifiOff className="w-3 h-3" />
                Disconnected
              </>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {showFilters && (
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowFilterMenu(!showFilterMenu)}
                className={filter !== 'all' ? 'text-accent-blue' : ''}
              >
                <Filter className="w-4 h-4" />
              </Button>

              {showFilterMenu && (
                <div className="absolute right-0 top-full mt-1 p-2 bg-bg-secondary border border-border-default rounded-md shadow-lg z-10 min-w-[150px]">
                  {activityTypes.map((type) => (
                    <button
                      key={type.value}
                      onClick={() => {
                        setFilter(type.value);
                        setShowFilterMenu(false);
                      }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md ${
                        filter === type.value
                          ? 'bg-accent-blue/10 text-accent-blue'
                          : 'hover:bg-bg-tertiary text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {type.icon && <type.icon className="w-4 h-4" />}
                      {type.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={onTogglePause}
            title={isPaused ? 'Resume' : 'Pause'}
          >
            {isPaused ? (
              <Play className="w-4 h-4" />
            ) : (
              <Pause className="w-4 h-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Filter Pills */}
      {showFilters && (
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          {activityTypes.map((type) => (
            <FilterButton
              key={type.value}
              active={filter === type.value}
              onClick={() => setFilter(type.value)}
              icon={type.icon}
            >
              {type.label}
            </FilterButton>
          ))}
        </div>
      )}

      {/* Feed */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonActivityItem key={i} />
          ))}
        </div>
      ) : filteredActivities.length === 0 ? (
        <EmptyState
          icon={filter === 'all' ? Wifi : activityTypes.find(t => t.value === filter)?.icon || Wifi}
          title={filter === 'all' ? 'No activity yet' : `No ${filter} activity`}
          description={
            filter === 'all'
              ? 'Agent activity will appear here in real-time'
              : `No ${filter}-related activity to display. Try a different filter.`
          }
        />
      ) : (
        <div className="space-y-3">
          {filteredActivities.map((activity, index) => (
            <ActivityItem
              key={`${activity.timestamp}-${index}`}
              activity={activity}
            />
          ))}

          {/* Load More */}
          {showLoadMore && hasMore && (
            <div className="flex justify-center pt-4">
              <Button variant="secondary" onClick={onLoadMore}>
                Load More
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Paused indicator */}
      {isPaused && activities.length > 0 && (
        <div className="text-center py-2 text-sm text-text-muted">
          <span className="inline-flex items-center gap-1">
            <Pause className="w-3 h-3" />
            Feed paused
          </span>
        </div>
      )}
    </div>
  );
}
