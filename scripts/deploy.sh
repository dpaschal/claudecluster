#!/bin/bash
# Rolling deployment script for claudecluster
# Updates nodes one at a time, verifying health before proceeding

set -e

# Configuration
REPO_DIR="/home/paschal/claudecluster"
SERVICE_NAME="claudecluster"
HEALTH_CHECK_TIMEOUT=30
HEALTH_CHECK_INTERVAL=2

# Cluster nodes (in deployment order - workers first, then followers, leader last)
NODES=(
    "htnas02:100.103.240.34:worker"
    "forge:100.94.211.117:leader-eligible"
    "terminus-1:100.120.202.76:leader-eligible"
    "rog2:100.104.78.123:leader-eligible"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Get current node hostname
CURRENT_NODE=$(hostname)

# Health check function
check_health() {
    local host=$1
    local port=${2:-50051}
    local timeout=$HEALTH_CHECK_TIMEOUT
    local elapsed=0

    log_info "Waiting for $host to become healthy..."

    while [ $elapsed -lt $timeout ]; do
        # Try to connect to gRPC port
        if nc -z "$host" "$port" 2>/dev/null; then
            log_info "$host is healthy (port $port responding)"
            return 0
        fi
        sleep $HEALTH_CHECK_INTERVAL
        elapsed=$((elapsed + HEALTH_CHECK_INTERVAL))
    done

    log_error "$host failed health check after ${timeout}s"
    return 1
}

# Deploy to a single node
deploy_node() {
    local node_name=$1
    local node_ip=$2
    local node_role=$3

    log_info "=========================================="
    log_info "Deploying to $node_name ($node_ip) - $node_role"
    log_info "=========================================="

    if [ "$node_name" == "$CURRENT_NODE" ]; then
        # Local deployment
        log_info "Local deployment on $node_name"

        cd "$REPO_DIR"

        log_info "Pulling latest code..."
        git pull origin main

        log_info "Installing dependencies..."
        npm ci

        log_info "Building..."
        npm run build

        log_info "Restarting service..."
        if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
            sudo systemctl restart "$SERVICE_NAME"
        else
            # If no systemd service, try to restart manually
            pkill -f "node.*claudecluster" || true
            sleep 2
            nohup node "$REPO_DIR/dist/index.js" > /tmp/claudecluster.log 2>&1 &
        fi
    else
        # Remote deployment via SSH
        log_info "Remote deployment to $node_name via SSH"

        ssh "$node_name" bash -s << EOF
            set -e
            cd "$REPO_DIR"

            echo "Pulling latest code..."
            git pull origin main

            echo "Installing dependencies..."
            npm ci

            echo "Building..."
            npm run build

            echo "Restarting service..."
            if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
                sudo systemctl restart "$SERVICE_NAME"
            else
                pkill -f "node.*claudecluster" || true
                sleep 2
                nohup node "$REPO_DIR/dist/index.js" > /tmp/claudecluster.log 2>&1 &
            fi
EOF
    fi

    # Wait for health check
    sleep 3
    if ! check_health "$node_ip"; then
        log_error "Deployment to $node_name FAILED - aborting rolling update"
        return 1
    fi

    log_info "Deployment to $node_name SUCCESSFUL"
    return 0
}

# Main deployment logic
main() {
    local target_node=${1:-""}
    local skip_confirm=${2:-""}

    log_info "Claude Cluster Rolling Deployment"
    log_info "Current node: $CURRENT_NODE"
    echo

    if [ -n "$target_node" ]; then
        # Deploy to specific node only
        for node_spec in "${NODES[@]}"; do
            IFS=':' read -r name ip role <<< "$node_spec"
            if [ "$name" == "$target_node" ]; then
                deploy_node "$name" "$ip" "$role"
                exit $?
            fi
        done
        log_error "Unknown node: $target_node"
        exit 1
    fi

    # Full rolling deployment
    log_info "Deployment order:"
    for node_spec in "${NODES[@]}"; do
        IFS=':' read -r name ip role <<< "$node_spec"
        echo "  - $name ($ip) - $role"
    done
    echo

    if [ "$skip_confirm" != "-y" ]; then
        read -p "Proceed with rolling deployment? [y/N] " confirm
        if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
            log_info "Deployment cancelled"
            exit 0
        fi
    fi

    # Deploy to each node
    for node_spec in "${NODES[@]}"; do
        IFS=':' read -r name ip role <<< "$node_spec"

        if ! deploy_node "$name" "$ip" "$role"; then
            log_error "Rolling deployment ABORTED at $name"
            log_warn "Remaining nodes NOT updated. Manual intervention required."
            exit 1
        fi

        echo
        log_info "Waiting 5 seconds before next node..."
        sleep 5
    done

    log_info "=========================================="
    log_info "Rolling deployment COMPLETE"
    log_info "All nodes updated successfully"
    log_info "=========================================="
}

# Show usage
usage() {
    echo "Usage: $0 [node_name] [-y]"
    echo
    echo "Options:"
    echo "  node_name   Deploy to specific node only (default: all nodes)"
    echo "  -y          Skip confirmation prompt"
    echo
    echo "Available nodes:"
    for node_spec in "${NODES[@]}"; do
        IFS=':' read -r name ip role <<< "$node_spec"
        echo "  - $name ($ip)"
    done
}

# Parse arguments
if [ "$1" == "-h" ] || [ "$1" == "--help" ]; then
    usage
    exit 0
fi

main "$@"
