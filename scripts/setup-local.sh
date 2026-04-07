#!/bin/bash
# Setup local GitSwarm development stack
#
# Starts Gitea + PostgreSQL, runs migrations, creates admin user and
# initial agent, outputs connection details for Claude Code.
#
# Usage: bash scripts/setup-local.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== GitSwarm Local Stack Setup ==="
echo ""

# ── Step 1: Start infrastructure ──
echo "Starting Gitea + PostgreSQL..."
docker compose -f "$SCRIPT_DIR/local-stack.yml" up -d

echo "Waiting for PostgreSQL..."
until docker exec gitswarm-dev-postgres pg_isready -U gitswarm -q 2>/dev/null; do
  sleep 1
done

echo "Waiting for Gitea..."
until curl -sf http://localhost:3001/api/healthz >/dev/null 2>&1; do
  sleep 1
done
echo "Infrastructure ready."
echo ""

# ── Step 2: Run migrations ──
echo "Running database migrations..."
psql "postgresql://gitswarm:gitswarm_dev@localhost:5432/gitswarm" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" 2>/dev/null || true

for f in "$PROJECT_DIR/src/db/migrations/"*.sql; do
  echo "  Applying $(basename $f)..."
  psql "postgresql://gitswarm:gitswarm_dev@localhost:5432/gitswarm" -f "$f" -q 2>/dev/null
done
echo "Migrations complete."
echo ""

# ── Step 3: Create Gitea admin ──
echo "Creating Gitea admin user..."
docker exec gitswarm-dev-gitea su git -c \
  '/usr/local/bin/gitea admin user create --username gitswarm-admin --password "AdminPass123!" --email admin@gitswarm.local --admin' 2>/dev/null || true

sleep 2

# Disable must-change-password
curl -sf http://localhost:3001/api/v1/admin/users/gitswarm-admin \
  -X PATCH \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n 'gitswarm-admin:AdminPass123!' | base64)" \
  -d '{"login_name":"gitswarm-admin","source_id":0,"must_change_password":false}' >/dev/null 2>&1 || true

# Create admin token
GITEA_TOKEN=$(curl -sf http://localhost:3001/api/v1/users/gitswarm-admin/tokens \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n 'gitswarm-admin:AdminPass123!' | base64)" \
  -d "{\"name\":\"dev-token-$(date +%s)\",\"scopes\":[\"all\"]}" | python3 -c "import sys,json; print(json.load(sys.stdin)['sha1'])")

echo "Gitea admin token: $GITEA_TOKEN"
echo ""

# ── Step 4: Create org + repo ──
echo "Creating organization and repository..."
curl -sf http://localhost:3001/api/v1/orgs \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: token $GITEA_TOKEN" \
  -d '{"username":"dev-org","visibility":"private"}' >/dev/null 2>&1 || true

curl -sf http://localhost:3001/api/v1/orgs/dev-org/repos \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: token $GITEA_TOKEN" \
  -d '{"name":"test-project","auto_init":true,"default_branch":"main"}' >/dev/null 2>&1 || true

echo "Created dev-org/test-project"
echo ""

# ── Step 5: Write .env for local server ──
cat > "$PROJECT_DIR/.env" <<EOF
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
DATABASE_URL=postgresql://gitswarm:gitswarm_dev@localhost:5432/gitswarm
REDIS_URL=redis://localhost:6379
GITEA_URL=http://localhost:3001
GITEA_ADMIN_TOKEN=$GITEA_TOKEN
GITEA_INTERNAL_SECRET=local-dev-secret
GITEA_SSH_URL=ssh://git@localhost:2222
GITEA_EXTERNAL_URL=http://localhost:3001
DEFAULT_GIT_BACKEND=gitea
EOF

echo "Wrote .env file"
echo ""

# ── Output connection details ──
echo "=========================================="
echo "  GitSwarm Local Stack Ready"
echo "=========================================="
echo ""
echo "Services:"
echo "  GitSwarm API:  http://localhost:3000  (start with: npm run dev)"
echo "  Gitea Web:     http://localhost:3001"
echo "  Gitea SSH:     ssh://git@localhost:2222"
echo "  PostgreSQL:    postgresql://gitswarm:gitswarm_dev@localhost:5432/gitswarm"
echo ""
echo "Gitea Admin:"
echo "  Username: gitswarm-admin"
echo "  Password: AdminPass123!"
echo "  Token:    $GITEA_TOKEN"
echo ""
echo "Git Clone URL:"
echo "  http://localhost:3001/dev-org/test-project.git"
echo ""
echo "Next steps:"
echo "  1. Start the server:  npm run build && npm start"
echo "     (or for dev:       npm run dev)"
echo ""
echo "  2. Register an agent:"
echo "     curl -X POST http://localhost:3000/api/v1/agents \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"name\": \"my-agent\"}'"
echo ""
echo "  3. Use the returned api_key for all authenticated requests"
echo ""
echo "To stop: docker compose -f scripts/local-stack.yml down"
echo "To reset: docker compose -f scripts/local-stack.yml down -v"
