import { Pause, Play, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { Button, Spinner, EmptyState } from '../Common';
import ActivityItem from './ActivityItem';

export default function ActivityFeed({
  activities,
  isConnected,
  isPaused,
  onTogglePause,
  onRefresh,
  loading,
}) {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
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

      {/* Feed */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : activities.length === 0 ? (
        <EmptyState
          icon={Wifi}
          title="No activity yet"
          description="Agent activity will appear here in real-time"
        />
      ) : (
        <div className="space-y-3">
          {activities.map((activity, index) => (
            <ActivityItem
              key={`${activity.timestamp}-${index}`}
              activity={activity}
            />
          ))}
        </div>
      )}
    </div>
  );
}
