#!/bin/bash
# Create Hyperledger Fabric channel
# Somalia Education Digital Certification Platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="${NETWORK_DIR}/bin"
CONFIG_DIR="${NETWORK_DIR}/config"
CHANNEL_NAME="education-channel"

# Add bin directory to PATH and set config path
export PATH="${BIN_DIR}:${PATH}"
export FABRIC_CFG_PATH="${CONFIG_DIR}"

echo "Creating channel: ${CHANNEL_NAME}"

# For Fabric 2.x, we only need to generate the channel genesis block
# The channel will be created using this genesis block
echo "Generating channel genesis block for Fabric 2.x..."

"${BIN_DIR}/configtxgen" -profile EducationChannel \
    -outputBlock "${NETWORK_DIR}/channel-artifacts/${CHANNEL_NAME}.block" \
    -channelID ${CHANNEL_NAME} \
    -configPath "${NETWORK_DIR}/network-config"

echo "✅ Channel artifacts created successfully"
echo "📁 Location: ${NETWORK_DIR}/channel-artifacts"
