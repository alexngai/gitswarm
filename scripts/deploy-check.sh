#!/usr/bin/env bash
# Pre-deploy validation script
# Checks that required env vars are set and services are reachable

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

check_var() {
  local var_name=$1
  local required=${2:-true}
  if [ -z "${!var_name:-}" ]; then
    if [ "$required" = true ]; then
      echo -e "${RED}MISSING${NC}  $var_name"
      ERRORS=$((ERRORS + 1))
    else
      echo -e "${YELLOW}SKIPPED${NC}  $var_name (optional)"
    fi
  else
    echo -e "${GREEN}OK${NC}      $var_name"
  fi
}

echo "=== BotHub Deploy Check ==="
echo ""
echo "--- Required Variables ---"
check_var DATABASE_URL
check_var REDIS_URL
check_var SESSION_SECRET
check_var BASE_URL

echo ""
echo "--- Optional Variables ---"
check_var GITHUB_APP_ID false
check_var GITHUB_PRIVATE_KEY false
check_var GITHUB_WEBHOOK_SECRET false
check_var GITHUB_CLIENT_ID false
check_var GITHUB_CLIENT_SECRET false
check_var OPENAI_API_KEY false

echo ""
echo "--- Connectivity ---"

# Test database
if [ -n "${DATABASE_URL:-}" ]; then
  if node -e "
    import('pg').then(({default: pg}) => {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
      pool.query('SELECT 1').then(() => { console.log('OK'); pool.end(); }).catch(e => { console.log('FAIL: ' + e.message); pool.end(); process.exit(1); });
    });
  " 2>/dev/null; then
    echo -e "${GREEN}OK${NC}      Database connection"
  else
    echo -e "${RED}FAIL${NC}    Database connection"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo -e "${YELLOW}SKIPPED${NC}  Database connection (no DATABASE_URL)"
fi

# Test Redis
if [ -n "${REDIS_URL:-}" ]; then
  if node -e "
    import('ioredis').then(({default: Redis}) => {
      const r = new Redis(process.env.REDIS_URL, { connectTimeout: 5000, lazyConnect: true });
      r.connect().then(() => r.ping()).then(() => { console.log('OK'); r.disconnect(); }).catch(e => { console.log('FAIL: ' + e.message); r.disconnect(); process.exit(1); });
    });
  " 2>/dev/null; then
    echo -e "${GREEN}OK${NC}      Redis connection"
  else
    echo -e "${RED}FAIL${NC}    Redis connection"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo -e "${YELLOW}SKIPPED${NC}  Redis connection (no REDIS_URL)"
fi

echo ""
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}$ERRORS issue(s) found. Fix before deploying.${NC}"
  exit 1
else
  echo -e "${GREEN}All checks passed. Ready to deploy.${NC}"
fi
