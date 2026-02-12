#!/bin/bash
# Start/Stop Hyperledger Fabric test network
# Somalia Education Digital Certification Platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"

function networkUp() {
    echo "🚀 Starting Hyperledger Fabric network..."
    
    # Start Docker containers
    docker-compose -f "${NETWORK_DIR}/docker/docker-compose.yaml" up -d
    
    # Wait for containers to be ready
    sleep 5
    
    # Create channel
    bash "${SCRIPT_DIR}/create-channel.sh"
    
    # Join peers to channel
    bash "${SCRIPT_DIR}/join-peers.sh"
    
    echo "✅ Network is up and running!"
}

function networkDown() {
    echo "🛑 Stopping Hyperledger Fabric network..."
    
    # Stop Docker containers
    docker-compose -f "${NETWORK_DIR}/docker/docker-compose.yaml" down
    
    # Remove volumes
    docker volume prune -f
    
    echo "✅ Network stopped successfully!"
}

function networkClean() {
    echo "🧹 Cleaning up network artifacts..."
    
    networkDown
    
    # Remove generated crypto materials
    rm -rf "${NETWORK_DIR}/organizations"
    rm -rf "${NETWORK_DIR}/channel-artifacts"
    
    # Remove chaincode packages
    rm -f *.tar.gz
    
    echo "✅ Cleanup complete!"
}

# Main script logic
case "$1" in
    up)
        networkUp
        ;;
    down)
        networkDown
        ;;
    clean)
        networkClean
        ;;
    restart)
        networkDown
        sleep 2
        networkUp
        ;;
    *)
        echo "Usage: $0 {up|down|clean|restart}"
        echo "  up      - Start the network"
        echo "  down    - Stop the network"
        echo "  clean   - Stop and remove all artifacts"
        echo "  restart - Restart the network"
        exit 1
        ;;
esac
