#!/bin/bash
# One-click network setup for NDCS Blockchain Network
# Automates everything from organizations.yaml to running chaincode

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"

function banner() {
    echo "🏛️  Somalia National Digital Trust System (NDTS)"
    echo "📚 Education Sector Blockchain Network"
    echo "🔧 Automated Network Setup"
    echo "=================================="
}

function checkPrerequisites() {
    echo "🔍 Checking prerequisites..."
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        echo "❌ Docker is not installed"
        exit 1
    fi
    
    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        echo "❌ Docker Compose is not installed"
        exit 1
    fi
    
    # Check Fabric binaries
    if [ ! -f "${NETWORK_DIR}/bin/cryptogen" ]; then
        echo "❌ Fabric binaries not found. Run: ./install-fabric.sh f d b"
        exit 1
    fi
    
    # Check organizations.yaml
    if [ ! -f "${NETWORK_DIR}/network-config/organizations.yaml" ]; then
        echo "❌ organizations.yaml not found"
        exit 1
    fi
    
    echo "✅ Prerequisites check passed"
}

function generateConfigs() {
    echo "📝 Generating network configurations..."
    bash "${SCRIPT_DIR}/generate-orgs.sh"
}

function generateCrypto() {
    echo "🔐 Generating cryptographic materials..."
    bash "${SCRIPT_DIR}/generate-crypto.sh"
}

function startNetwork() {
    echo "🚀 Starting Docker containers..."
    docker-compose -f "${NETWORK_DIR}/docker/docker-compose.yaml" up -d
    
    echo "⏳ Waiting for containers to be ready..."
    sleep 10
    
    # Check if containers are running
    if ! docker ps | grep -q "orderer.ndts.gov.so"; then
        echo "❌ Orderer container failed to start"
        docker logs orderer.ndts.gov.so
        exit 1
    fi
    
    echo "✅ Network containers started"
}

function createChannel() {
    echo "📡 Creating education channel..."
    bash "${SCRIPT_DIR}/create-channel.sh"
}

function deployChaincode() {
    echo "📦 Deploying certificate chaincode..."
    bash "${SCRIPT_DIR}/deploy-chaincode.sh"
}

function verifyNetwork() {
    echo "🔍 Verifying network health..."
    
    # Check channel
    echo "Checking peer channels..."
    docker exec peer0.mogadishu.university.so peer channel list | grep -q "education-channel" || {
        echo "❌ Channel not found on peer0.mogadishu.university.so"
        exit 1
    }
    
    # Check chaincode
    echo "Checking chaincode..."
    docker exec peer0.mogadishu.university.so peer lifecycle chaincode queryinstalled | grep -q "certificate-chaincode" || {
        echo "❌ Chaincode not installed"
        exit 1
    }
    
    # Test chaincode
    echo "Testing chaincode..."
    docker exec peer0.mogadishu.university.so peer chaincode invoke \
        -o orderer.ndts.gov.so:7050 \
        -C education-channel \
        -n certificate-chaincode \
        --cafile /opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/ordererOrganizations/ministry.gov.so/msp/tlscacerts/tlsca.ministry.gov.so-cert.pem \
        --tls \
        -c '{"Args":["ReadCertificate","CERT-001"]}' \
        --peerAddresses peer0.mogadishu.university.so:7051 \
        --tlsRootCertFiles /opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/mogadishu.university.so/peers/peer0.mogadishu.university.so/tls/ca.crt \
        --peerAddresses peer0.hargeisa.university.so:7051 \
        --tlsRootCertFiles /opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/hargeisa.university.so/peers/peer0.hargeisa.university.so/tls/ca.crt \
        2>/dev/null || echo "⚠️  Initial chaincode test failed (expected for fresh network)"
    
    echo "✅ Network verification complete"
}

function showNextSteps() {
    echo ""
    echo "🎉 Network setup complete!"
    echo "=================================="
    echo ""
    echo "📊 Network Status:"
    echo "  • Orderer: orderer.ndts.gov.so:7050"
    echo "  • Peers: peer0.mogadishu.university.so:7051, peer0.hargeisa.university.so:7051"
    echo "  • Channel: education-channel"
    echo "  • Chaincode: certificate-chaincode"
    echo ""
    echo "🔗 Next Steps:"
    echo "  1. Start Gateway API:"
    echo "     cd ../gateway-api && make run"
    echo ""
    echo "  2. Test API:"
    echo "     curl http://localhost:8080/api/v1/health"
    echo ""
    echo "  3. Issue certificate:"
    echo "     curl -X POST http://localhost:8080/api/v1/issue \\"
    echo "          -H 'Content-Type: application/json' \\"
    echo "          -d '{\"id\":\"CERT-002\",\"studentId\":\"SMU-2024-00002\",\"studentName\":\"Test Student\",\"degree\":\"Test Degree\",\"university\":\"Mogadishu University\",\"graduationDate\":\"2024-06-15\",\"hash\":\"test123\"}'"
    echo ""
    echo "🛠️  Management Commands:"
    echo "  • Stop network:  ./scripts/test-network.sh down"
    echo "  • Restart:       ./scripts/test-network.sh restart"
    echo "  • Clean all:     ./scripts/test-network.sh clean"
    echo "  • View logs:     docker logs peer0.mogadishu.university.so"
    echo ""
    echo "📁 Generated Files:"
    echo "  • Crypto material: organizations/"
    echo "  • Channel artifacts: channel-artifacts/"
    echo "  • Config files: network-config/"
    echo ""
}

function main() {
    banner
    checkPrerequisites
    generateConfigs
    generateCrypto
    startNetwork
    createChannel
    deployChaincode
    verifyNetwork
    showNextSteps
}

# Handle script arguments
case "${1:-}" in
    --clean)
        echo "🧹 Cleaning up previous setup..."
        bash "${SCRIPT_DIR}/test-network.sh" clean
        ;;
    --help|-h)
        echo "Usage: $0 [--clean|--help]"
        echo "  --clean  Clean up previous network setup before starting"
        echo "  --help   Show this help message"
        exit 0
        ;;
    "")
        # Default: full setup
        ;;
    *)
        echo "Unknown option: $1"
        echo "Use --help for usage information"
        exit 1
        ;;
esac

main "$@"
