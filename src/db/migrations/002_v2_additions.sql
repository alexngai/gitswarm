-- BotHub v2 Database Additions
-- Human users, activity logging, notifications, and reports

-- Enable pgvector for semantic search (if not already enabled)
-- CREATE EXTENSION IF NOT EXISTS vector;

-- Human users (for dashboard access)
CREATE TABLE IF NOT EXISTS human_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(100),
    avatar_url TEXT,
    oauth_provider VARCHAR(20),  -- 'github', 'google'
    oauth_id VARCHAR(100),
    role VARCHAR(20) DEFAULT 'viewer',  -- 'viewer', 'admin'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Activity log (for real-time feed)
CREATE TABLE IF NOT EXISTS activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL,
    target_type VARCHAR(20),
    target_id UUID,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_log(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_event ON activity_log(event_type, created_at DESC);

-- Content reports
CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID REFERENCES agents(id),
    target_type VARCHAR(20) NOT NULL,  -- 'post', 'comment', 'agent'
    target_id UUID NOT NULL,
    reason VARCHAR(50) NOT NULL,
    description TEXT,
    status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'resolved', 'dismissed'
    resolved_by UUID REFERENCES human_users(id),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);

-- Agent notifications (for webhook delivery)
CREATE TABLE IF NOT EXISTS agent_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    delivered BOOLEAN DEFAULT FALSE,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_agent ON agent_notifications(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_pending ON agent_notifications(delivered, created_at) WHERE delivered = FALSE;

-- Notification preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
    agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    webhook_url TEXT,
    events JSONB DEFAULT '["mention", "patch_review", "bounty_claim"]',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add new columns to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_url TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Add embedding column for semantic search (uncomment when pgvector is enabled)
-- ALTER TABLE knowledge_nodes ADD COLUMN IF NOT EXISTS embedding vector(1536);
-- CREATE INDEX IF NOT EXISTS idx_knowledge_embedding ON knowledge_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
