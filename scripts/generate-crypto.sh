#!/bin/bash
# Generate cryptographic materials for Hyperledger Fabric network
# Somalia Education Digital Certification Platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="${NETWORK_DIR}/bin"

# Add bin directory to PATH
export PATH="${BIN_DIR}:${PATH}"

echo "Generating cryptographic materials..."

# Check if cryptogen exists
if [ ! -f "${BIN_DIR}/cryptogen" ]; then
    echo "❌ cryptogen binary not found in ${BIN_DIR}"
    echo "Please run: cd ${NETWORK_DIR} && ./install-fabric.sh f d b s c"
    exit 1
fi

# Generate crypto materials using cryptogen
"${BIN_DIR}/cryptogen" generate --config="${NETWORK_DIR}/network-config/crypto-config.yaml" --output="${NETWORK_DIR}/organizations"

if [ $? -eq 0 ]; then
    echo "✅ Cryptographic materials generated successfully"
    echo "📁 Location: ${NETWORK_DIR}/organizations"
else
    echo "❌ Failed to generate cryptographic materials"
    exit 1
fi

# Set proper permissions
chmod -R 755 "${NETWORK_DIR}/organizations"

echo "✅ Crypto generation complete!"
