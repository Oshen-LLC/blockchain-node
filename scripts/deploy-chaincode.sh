#!/bin/bash
# Deploy chaincode to Hyperledger Fabric network
# Somalia Education Digital Certification Platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
CHAINCODE_NAME="certificate-chaincode"
CHAINCODE_VERSION="1.0"
CHANNEL_NAME="education-channel"

echo "Deploying chaincode: ${CHAINCODE_NAME} v${CHAINCODE_VERSION}"

# Package chaincode
echo "📦 Packaging chaincode..."
peer lifecycle chaincode package ${CHAINCODE_NAME}.tar.gz \
    --path "${PROJECT_DIR}/chaincode/src" \
    --lang golang \
    --label ${CHAINCODE_NAME}_${CHAINCODE_VERSION}

# Install on Mogadishu University peer
echo "📥 Installing on Mogadishu University peer..."
export CORE_PEER_LOCALMSPID="MogadishuUniversityMSP"
export CORE_PEER_ADDRESS=peer0.mogadishu.university.so:7051
peer lifecycle chaincode install ${CHAINCODE_NAME}.tar.gz

# Install on Hargeisa University peer
echo "📥 Installing on Hargeisa University peer..."
export CORE_PEER_LOCALMSPID="HargeisaUniversityMSP"
export CORE_PEER_ADDRESS=peer0.hargeisa.university.so:7051
peer lifecycle chaincode install ${CHAINCODE_NAME}.tar.gz

# Get package ID
PACKAGE_ID=$(peer lifecycle chaincode queryinstalled | grep ${CHAINCODE_NAME}_${CHAINCODE_VERSION} | awk '{print $3}' | sed 's/,$//')

echo "📋 Package ID: ${PACKAGE_ID}"

# Approve for Mogadishu University
echo "✅ Approving for Mogadishu University..."
export CORE_PEER_LOCALMSPID="MogadishuUniversityMSP"
peer lifecycle chaincode approveformyorg \
    -o orderer.ministry.gov.so:7050 \
    --channelID ${CHANNEL_NAME} \
    --name ${CHAINCODE_NAME} \
    --version ${CHAINCODE_VERSION} \
    --package-id ${PACKAGE_ID} \
    --sequence 1

# Approve for Hargeisa University
echo "✅ Approving for Hargeisa University..."
export CORE_PEER_LOCALMSPID="HargeisaUniversityMSP"
peer lifecycle chaincode approveformyorg \
    -o orderer.ministry.gov.so:7050 \
    --channelID ${CHANNEL_NAME} \
    --name ${CHAINCODE_NAME} \
    --version ${CHAINCODE_VERSION} \
    --package-id ${PACKAGE_ID} \
    --sequence 1

# Commit chaincode
echo "🚀 Committing chaincode..."
peer lifecycle chaincode commit \
    -o orderer.ministry.gov.so:7050 \
    --channelID ${CHANNEL_NAME} \
    --name ${CHAINCODE_NAME} \
    --version ${CHAINCODE_VERSION} \
    --sequence 1

echo "✅ Chaincode deployed successfully!"
echo "🎉 ${CHAINCODE_NAME} v${CHAINCODE_VERSION} is now active on ${CHANNEL_NAME}"
