#!/bin/bash
# Deploy chaincode to Hyperledger Fabric network
# Somalia Education Digital Certification Platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$NETWORK_DIR")"
BIN_DIR="${NETWORK_DIR}/bin"
CONFIG_DIR="${NETWORK_DIR}/config"
CHAINCODE_NAME="certificate-chaincode"
CHAINCODE_VERSION="1.0"
CHANNEL_NAME="education-channel"

# Add bin directory to PATH and set config path
export PATH="${BIN_DIR}:${PATH}"
export FABRIC_CFG_PATH="${CONFIG_DIR}"

echo "Deploying chaincode: ${CHAINCODE_NAME} v${CHAINCODE_VERSION}"

# Package chaincode
echo "📦 Packaging chaincode..."
"${BIN_DIR}/peer" lifecycle chaincode package ${CHAINCODE_NAME}.tar.gz \
    --path "${PROJECT_DIR}/chaincode" \
    --lang golang \
    --label ${CHAINCODE_NAME}_${CHAINCODE_VERSION}

# Install on Mogadishu University peer
echo "📥 Installing on Mogadishu University peer..."
export CORE_PEER_TLS_ENABLED=false
export CORE_PEER_LOCALMSPID="MogadishuUniversityMSP"
export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/mogadishu.university.so/users/Admin@mogadishu.university.so/msp"
export CORE_PEER_ADDRESS=localhost:7051

# Wait for peer to be ready
sleep 5

"${BIN_DIR}/peer" lifecycle chaincode install ${CHAINCODE_NAME}.tar.gz

# Install on Hargeisa University peer
echo "📥 Installing on Hargeisa University peer..."
export CORE_PEER_TLS_ENABLED=false
export CORE_PEER_LOCALMSPID="HargeisaUniversityMSP"
export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/hargeisa.university.so/users/Admin@hargeisa.university.so/msp"
export CORE_PEER_ADDRESS=localhost:7052

"${BIN_DIR}/peer" lifecycle chaincode install ${CHAINCODE_NAME}.tar.gz

# Get package ID
PACKAGE_ID=$("${BIN_DIR}/peer" lifecycle chaincode queryinstalled | grep ${CHAINCODE_NAME}_${CHAINCODE_VERSION} | awk '{print $3}' | sed 's/,$//')

echo "📋 Package ID: ${PACKAGE_ID}"

# Approve for Mogadishu University
echo "✅ Approving for Mogadishu University..."
export CORE_PEER_LOCALMSPID="MogadishuUniversityMSP"
export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_DIR}/organizations/peerOrganizations/mogadishu.university.so/peers/peer0.mogadishu.university.so/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/mogadishu.university.so/users/Admin@mogadishu.university.so/msp"
export CORE_PEER_ADDRESS=localhost:7051
"${BIN_DIR}/peer" lifecycle chaincode approveformyorg \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.ndts.gov.so \
    --tls \
    --cafile "${NETWORK_DIR}/organizations/ordererOrganizations/ministry.gov.so/orderers/orderer.ministry.gov.so/msp/tlscacerts/tlsca.ministry.gov.so-cert.pem" \
    --channelID ${CHANNEL_NAME} \
    --name ${CHAINCODE_NAME} \
    --version ${CHAINCODE_VERSION} \
    --package-id ${PACKAGE_ID} \
    --sequence 1

# Approve for Hargeisa University
echo "✅ Approving for Hargeisa University..."
export CORE_PEER_LOCALMSPID="HargeisaUniversityMSP"
export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_DIR}/organizations/peerOrganizations/hargeisa.university.so/peers/peer0.hargeisa.university.so/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/hargeisa.university.so/users/Admin@hargeisa.university.so/msp"
export CORE_PEER_ADDRESS=localhost:7052
"${BIN_DIR}/peer" lifecycle chaincode approveformyorg \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.ndts.gov.so \
    --tls \
    --cafile "${NETWORK_DIR}/organizations/ordererOrganizations/ministry.gov.so/orderers/orderer.ministry.gov.so/msp/tlscacerts/tlsca.ministry.gov.so-cert.pem" \
    --channelID ${CHANNEL_NAME} \
    --name ${CHAINCODE_NAME} \
    --version ${CHAINCODE_VERSION} \
    --package-id ${PACKAGE_ID} \
    --sequence 1

# Commit chaincode
echo "🚀 Committing chaincode..."
"${BIN_DIR}/peer" lifecycle chaincode commit \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.ndts.gov.so \
    --tls \
    --cafile "${NETWORK_DIR}/organizations/ordererOrganizations/ministry.gov.so/orderers/orderer.ministry.gov.so/msp/tlscacerts/tlsca.ministry.gov.so-cert.pem" \
    --channelID ${CHANNEL_NAME} \
    --name ${CHAINCODE_NAME} \
    --version ${CHAINCODE_VERSION} \
    --sequence 1 \
    --peerAddresses localhost:7051 \
    --tlsRootCertFiles "${NETWORK_DIR}/organizations/peerOrganizations/mogadishu.university.so/peers/peer0.mogadishu.university.so/tls/ca.crt" \
    --peerAddresses localhost:7052 \
    --tlsRootCertFiles "${NETWORK_DIR}/organizations/peerOrganizations/hargeisa.university.so/peers/peer0.hargeisa.university.so/tls/ca.crt"

echo "✅ Chaincode deployed successfully!"
echo "🎉 ${CHAINCODE_NAME} v${CHAINCODE_VERSION} is now active on ${CHANNEL_NAME}"
