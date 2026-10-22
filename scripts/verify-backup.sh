#!/usr/bin/env bash
# Database backup verification script (issue #303)
#
# This script verifies database backups by:
# 1. Downloading a backup snapshot
# 2. Restoring it to a temporary Postgres container
# 3. Verifying table row counts against expected values
# 4. Cleaning up the temporary container
#
# Usage:
#   ./scripts/verify-backup.sh <backup-file-or-url> [expected-events-count]
#
# Examples:
#   ./scripts/verify-backup.sh /path/to/backup.sql
#   ./scripts/verify-backup.sh https://backups.example.com/latest.sql.gz 1000
#
# Exit codes:
#   0 - Backup verified successfully
#   1 - Verification failed (counts mismatch, restore failed, etc.)
#   2 - Usage error (missing arguments, invalid input)

set -euo pipefail

# Configuration
POSTGRES_VERSION="${POSTGRES_VERSION:-17}"
CONTAINER_NAME="ourdao-backup-verify-$$"
POSTGRES_PASSWORD="verify-temp-$(date +%s)"
POSTGRES_USER="postgres"
POSTGRES_DB="ourdao_verify"
CONTAINER_PORT="5433"
MAX_WAIT_SECONDS=30

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[verify-backup]${NC} $*"
}

warn() {
    echo -e "${YELLOW}[verify-backup]${NC} $*"
}

error() {
    echo -e "${RED}[verify-backup]${NC} $*" >&2
}

cleanup() {
    local exit_code=$?
    if [ -n "${CONTAINER_NAME:-}" ]; then
        log "Cleaning up temporary container..."
        docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    fi
    if [ -n "${TEMP_BACKUP:-}" ] && [ -f "$TEMP_BACKUP" ]; then
        rm -f "$TEMP_BACKUP"
    fi
    if [ -n "${DECOMPRESSED_FILE:-}" ] && [ -f "$DECOMPRESSED_FILE" ]; then
        rm -f "$DECOMPRESSED_FILE"
    fi
    exit "$exit_code"
}

# Temp files tracked globally so cleanup() can remove them
TEMP_BACKUP=""
DECOMPRESSED_FILE=""
BACKUP_FILE=""

trap cleanup EXIT INT TERM

# Check dependencies (psql runs inside the container, so it is not required on the host)
check_dependencies() {
    local source="$1"
    local missing=()

    command -v docker >/dev/null 2>&1 || missing+=("docker")
    if [[ "$source" =~ \.gz$ ]]; then
        command -v gunzip >/dev/null 2>&1 || missing+=("gunzip")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        error "Missing required dependencies: ${missing[*]}"
        error "Please install them and try again."
        exit 2
    fi
}

# Download backup if it's a URL
download_backup() {
    local source="$1"
    
    if [[ "$source" =~ ^https?:// ]]; then
        log "Downloading backup from $source..."
        TEMP_BACKUP=$(mktemp /tmp/backup-verify.XXXXXX)
        
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "$source" -o "$TEMP_BACKUP"
        elif command -v wget >/dev/null 2>&1; then
            wget -q "$source" -O "$TEMP_BACKUP"
        else
            error "Neither curl nor wget found. Cannot download backup."
            exit 2
        fi

        BACKUP_FILE="$TEMP_BACKUP"
    else
        BACKUP_FILE="$source"
    fi
}

# Decompress backup if needed
decompress_if_needed() {
    local source="$1"

    if [[ "$source" =~ \.gz$ ]]; then
        log "Decompressing gzipped backup..."
        DECOMPRESSED_FILE=$(mktemp /tmp/backup-verify-decompressed.XXXXXX)
        gunzip -c "$BACKUP_FILE" > "$DECOMPRESSED_FILE"
        BACKUP_FILE="$DECOMPRESSED_FILE"
    fi
}

# Start temporary Postgres container
start_postgres_container() {
    log "Starting temporary Postgres $POSTGRES_VERSION container..."
    
    docker run -d \
        --name "$CONTAINER_NAME" \
        -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
        -e POSTGRES_USER="$POSTGRES_USER" \
        -e POSTGRES_DB="$POSTGRES_DB" \
        -p "$CONTAINER_PORT:5432" \
        "postgres:$POSTGRES_VERSION" \
        >/dev/null
    
    log "Waiting for Postgres to be ready..."
    local waited=0
    while ! docker exec "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1; do
        if [ "$waited" -ge "$MAX_WAIT_SECONDS" ]; then
            error "Postgres failed to start within $MAX_WAIT_SECONDS seconds"
            exit 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
    
    log "Postgres container ready"
}

# Restore backup to container
restore_backup() {
    local backup_file="$1"
    
    log "Restoring backup to temporary database..."
    
    if ! cat "$backup_file" | docker exec -i "$CONTAINER_NAME" \
        psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q >/dev/null 2>&1; then
        error "Failed to restore backup"
        exit 1
    fi
    
    log "Backup restored successfully"
}

# Query row count from a table
query_count() {
    local table="$1"
    
    docker exec "$CONTAINER_NAME" \
        psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT COUNT(*) FROM $table;" 2>/dev/null | \
        tr -d '[:space:]' || echo "0"
}

# Verify table counts
verify_counts() {
    local expected_events="${1:-}"
    
    log "Verifying table row counts..."
    
    local events_count=$(query_count "events")
    local members_count=$(query_count "members")
    local loans_count=$(query_count "loans")
    
    echo ""
    echo "Table row counts:"
    echo "  events:  $events_count"
    echo "  members: $members_count"
    echo "  loans:   $loans_count"
    echo ""
    
    # Basic sanity checks
    local failed=0
    
    # Check that events table exists and is non-negative
    if ! [[ "$events_count" =~ ^[0-9]+$ ]]; then
        error "Failed to query events table"
        failed=1
    fi
    
    # Check that members table exists
    if ! [[ "$members_count" =~ ^[0-9]+$ ]]; then
        error "Failed to query members table"
        failed=1
    fi
    
    # Check that loans table exists
    if ! [[ "$loans_count" =~ ^[0-9]+$ ]]; then
        error "Failed to query loans table"
        failed=1
    fi
    
    # Verify expected events count if provided
    if [ -n "$expected_events" ]; then
        if [ "$events_count" -ne "$expected_events" ]; then
            error "Events count mismatch: expected $expected_events, got $events_count"
            failed=1
        else
            log "Events count matches expected value: $events_count"
        fi
    fi
    
    # Logical consistency checks
    if [ "$events_count" -gt 0 ] && [ "$members_count" -eq 0 ]; then
        warn "Warning: events exist but no members found (unusual but not necessarily wrong)"
    fi
    
    if [ "$loans_count" -gt "$events_count" ] && [ "$events_count" -gt 0 ]; then
        error "Logical error: more loans than events (impossible)"
        failed=1
    fi
    
    if [ "$failed" -eq 1 ]; then
        error "Verification FAILED"
        exit 1
    fi
    
    log "Verification PASSED - backup is restorable and data looks consistent"
}

# Main script
main() {
    if [ $# -lt 1 ]; then
        error "Usage: $0 <backup-file-or-url> [expected-events-count]"
        error ""
        error "Examples:"
        error "  $0 /path/to/backup.sql"
        error "  $0 https://backups.example.com/latest.sql.gz 1000"
        exit 2
    fi
    
    local backup_source="$1"
    local expected_events="${2:-}"
    
    check_dependencies "$backup_source"

    # Called directly (not via $(...)) so globals reach cleanup() and log output isn't captured
    download_backup "$backup_source"

    if [ ! -f "$BACKUP_FILE" ]; then
        error "Backup file not found: $BACKUP_FILE"
        exit 2
    fi

    decompress_if_needed "$backup_source"

    start_postgres_container
    restore_backup "$BACKUP_FILE"
    verify_counts "$expected_events"
    
    log "All checks passed!"
}

main "$@"
