#!/bin/bash
# Create Hyperledger Fabric channel
# Somalia Education Digital Certification Platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="${NETWORK_DIR}/bin"
CHANNEL_NAME="education-channel"

# Add bin directory to PATH
export PATH="${BIN_DIR}:${PATH}"

echo "Creating channel: ${CHANNEL_NAME}"

# Generate genesis block
"${BIN_DIR}/configtxgen" -profile EducationOrdererGenesis \
    -channelID system-channel \
    -outputBlock "${NETWORK_DIR}/channel-artifacts/genesis.block" \
    -configPath "${NETWORK_DIR}/network-config"

# Generate channel creation transaction
"${BIN_DIR}/configtxgen" -profile EducationChannel \
    -outputCreateChannelTx "${NETWORK_DIR}/channel-artifacts/channel.tx" \
    -channelID ${CHANNEL_NAME} \
    -configPath "${NETWORK_DIR}/network-config"

# Generate anchor peer transactions
"${BIN_DIR}/configtxgen" -profile EducationChannel \
    -outputAnchorPeersUpdate "${NETWORK_DIR}/channel-artifacts/anchors/MogadishuMSPanchors.tx" \
    -channelID ${CHANNEL_NAME} \
    -asOrg MogadishuUniversityMSP \
    -configPath "${NETWORK_DIR}/network-config"

"${BIN_DIR}/configtxgen" -profile EducationChannel \
    -outputAnchorPeersUpdate "${NETWORK_DIR}/channel-artifacts/anchors/HargeisaMSPanchors.tx" \
    -channelID ${CHANNEL_NAME} \
    -asOrg HargeisaUniversityMSP \
    -configPath "${NETWORK_DIR}/network-config"

echo "✅ Channel artifacts created successfully"
echo "📁 Location: ${NETWORK_DIR}/channel-artifacts"
