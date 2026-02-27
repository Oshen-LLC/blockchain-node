#!/bin/bash

# Fabric CA Startup Script
# Somalia National Digital Trust System

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

function banner() {
    echo "🔐 Fabric CA Startup Script"
    echo "📚 Somalia National Digital Trust System"
    echo "=================================="
}

function checkPrerequisites() {
    echo "🔍 Checking prerequisites..."
    
    # Check if Docker is running
    if ! docker info > /dev/null 2>&1; then
        echo "❌ Docker is not running. Please start Docker first."
        exit 1
    fi
    
    # Check if docker-compose is available
    if ! command -v docker-compose > /dev/null 2>&1; then
        echo "❌ docker-compose is not installed."
        exit 1
    fi
    
    echo "✅ Prerequisites check passed"
}

function createDirectories() {
    echo "📁 Creating CA directories..."
    
    mkdir -p "$PROJECT_DIR/fabric-ca/ndts-root-ca"
    mkdir -p "$PROJECT_DIR/fabric-ca/mogadishu-ca"
    mkdir -p "$PROJECT_DIR/fabric-ca/hargeisa-ca"
    
    echo "✅ CA directories created"
}

function startCAs() {
    echo "🚀 Starting Fabric CA services..."
    
    cd "$PROJECT_DIR"
    
    # Start CA services
    docker-compose -f docker-compose-ca.yaml up -d
    
    echo "✅ Fabric CA services started"
}

function waitForCAs() {
    echo "⏳ Waiting for CA services to be ready..."
    
    # Wait for root CA
    echo "Waiting for Root CA..."
    for i in {1..30}; do
        if curl -k https://localhost:7054/api/v1/cainfo > /dev/null 2>&1; then
            echo "✅ Root CA is ready"
            break
        fi
        if [ $i -eq 30 ]; then
            echo "❌ Root CA failed to start"
            exit 1
        fi
        sleep 2
    done
    
    # Wait for Mogadishu CA
    echo "Waiting for Mogadishu CA..."
    for i in {1..30}; do
        if curl -k https://localhost:8054/api/v1/cainfo > /dev/null 2>&1; then
            echo "✅ Mogadishu CA is ready"
            break
        fi
        if [ $i -eq 30 ]; then
            echo "❌ Mogadishu CA failed to start"
            exit 1
        fi
        sleep 2
    done
    
    # Wait for Hargeisa CA
    echo "Waiting for Hargeisa CA..."
    for i in {1..30}; do
        if curl -k https://localhost:9054/api/v1/cainfo > /dev/null 2>&1; then
            echo "✅ Hargeisa CA is ready"
            break
        fi
        if [ $i -eq 30 ]; then
            echo "❌ Hargeisa CA failed to start"
            exit 1
        fi
        sleep 2
    done
    
    echo "✅ All CA services are ready"
}

function testCAs() {
    echo "🧪 Testing CA services..."
    
    # Test Root CA
    echo "Testing Root CA..."
    curl -k -s https://localhost:7054/api/v1/cainfo | jq . > /dev/null 2>&1 || {
        echo "❌ Root CA test failed"
        exit 1
    }
    
    # Test Mogadishu CA
    echo "Testing Mogadishu CA..."
    curl -k -s https://localhost:8054/api/v1/cainfo | jq . > /dev/null 2>&1 || {
        echo "❌ Mogadishu CA test failed"
        exit 1
    }
    
    # Test Hargeisa CA
    echo "Testing Hargeisa CA..."
    curl -k -s https://localhost:9054/api/v1/cainfo | jq . > /dev/null 2>&1 || {
        echo "❌ Hargeisa CA test failed"
        exit 1
    }
    
    echo "✅ All CA tests passed"
}

function showStatus() {
    echo "📊 Fabric CA Status:"
    echo "=================="
    
    echo "Root CA: https://localhost:7054"
    echo "Mogadishu CA: https://localhost:8054"
    echo "Hargeisa CA: https://localhost:9054"
    echo ""
    echo "🔗 CA Endpoints:"
    echo "  • Root CA Admin: https://localhost:7054"
    echo "  • Mogadishu CA: https://localhost:8054"
    echo "  • Hargeisa CA: https://localhost:9054"
    echo ""
    echo "👤 Admin Credentials:"
    echo "  • Username: admin"
    echo "  • Password: adminpw"
    echo ""
    echo "📝 Next Steps:"
    echo "  1. Test CA integration:"
    echo "     cd ../gateway-api && go test ./pkg/fabricca/..."
    echo ""
    echo "  2. Start Gateway API:"
    echo "     cd ../gateway-api && make run"
    echo ""
    echo "  3. Test school provisioning:"
    echo "     curl -X POST http://localhost:8080/api/v1/admin/schools/provision \\"
    echo "          -H 'Content-Type: application/json' \\"
    echo "          -d '{\"code\":\"TEST\",\"name\":\"Test University\",\"domain\":\"test.university.so\",\"type\":\"university\"}'"
    echo ""
    echo "🛠️ Management Commands:"
    echo "  • View logs: docker-compose -f docker-compose-ca.yaml logs -f"
    echo "  • Stop CAs: docker-compose -f docker-compose-ca.yaml down"
    echo "  • Restart CAs: docker-compose -f docker-compose-ca.yaml restart"
}

function main() {
    banner
    checkPrerequisites
    createDirectories
    startCAs
    waitForCAs
    testCAs
    showStatus
}

# Handle script arguments
case "${1:-}" in
    --stop)
        echo "🛑 Stopping Fabric CA services..."
        cd "$PROJECT_DIR"
        docker-compose -f docker-compose-ca.yaml down
        echo "✅ Fabric CA services stopped"
        ;;
    --restart)
        echo "🔄 Restarting Fabric CA services..."
        cd "$PROJECT_DIR"
        docker-compose -f docker-compose-ca.yaml restart
        echo "✅ Fabric CA services restarted"
        ;;
    --logs)
        echo "📋 Showing Fabric CA logs..."
        cd "$PROJECT_DIR"
        docker-compose -f docker-compose-ca.yaml logs -f
        ;;
    --status)
        echo "📊 Fabric CA Status:"
        docker-compose -f docker-compose-ca.yaml ps
        ;;
    --test)
        echo "🧪 Testing CA services..."
        testCAs
        ;;
    --help)
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --stop     Stop Fabric CA services"
        echo "  --restart  Restart Fabric CA services"
        echo "  --logs     Show Fabric CA logs"
        echo "  --status   Show Fabric CA status"
        echo "  --test     Test CA services"
        echo "  --help     Show this help message"
        echo ""
        echo "Default: Start Fabric CA services"
        ;;
    *)
        main
        ;;
esac
