#!/bin/bash
# Generate cryptographic materials for Hyperledger Fabric network
# Somalia Education Digital Certification Platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"

echo "Generating cryptographic materials..."

# Generate crypto materials using cryptogen
cryptogen generate --config="${NETWORK_DIR}/network-config/crypto-config.yaml" --output="${NETWORK_DIR}/organizations"

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
