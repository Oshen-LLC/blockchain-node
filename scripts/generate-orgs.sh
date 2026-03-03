#!/bin/bash
# Dynamic organization generator for Hyperledger Fabric
# Generates crypto-config.yaml and organizations from config

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${NETWORK_DIR}/network-config/organizations.yaml"

function generateCryptoConfig() {
    echo "🔧 Generating crypto-config.yaml from organizations.yaml..."
    
    cat > "${NETWORK_DIR}/network-config/crypto-config.yaml" << EOF
OrdererOrgs:
  - Name: Orderer
    Domain: ministry.gov.so
    EnableNodeOUs: true
    Specs:
      - Hostname: orderer

PeerOrgs:
EOF

    # Add peer organizations from config
    while IFS= read -r line; do
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*Name:[[:space:]]*([^[:space:]]+) ]]; then
            org_name="${BASH_REMATCH[1]}"
            echo "  - Name: $org_name" >> "${NETWORK_DIR}/network-config/crypto-config.yaml"
            
            # Find domain for this org
            domain=$(sed -n "/Name: $org_name/,/Domain:/p" "$CONFIG_FILE" | grep "Domain:" | awk '{print $2}')
            echo "    Domain: $domain" >> "${NETWORK_DIR}/network-config/crypto-config.yaml"
            echo "    EnableNodeOUs: true" >> "${NETWORK_DIR}/network-config/crypto-config.yaml"
            echo "    Template:" >> "${NETWORK_DIR}/network-config/crypto-config.yaml"
            echo "      Count: 1" >> "${NETWORK_DIR}/network-config/crypto-config.yaml"
            echo "    Users:" >> "${NETWORK_DIR}/network-config/crypto-config.yaml"
            echo "      Count: 1" >> "${NETWORK_DIR}/network-config/crypto-config.yaml"
            echo "" >> "${NETWORK_DIR}/network-config/crypto-config.yaml"
        fi
    done < "$CONFIG_FILE"
    
    echo "✅ crypto-config.yaml generated"
}

function generateChannelConfig() {
    echo "🔧 Generating configtx.yaml from organizations.yaml..."
    
    cat > "${NETWORK_DIR}/network-config/configtx.yaml" << EOF
Organizations:
EOF

    # Add organizations to configtx.yaml
    while IFS= read -r line; do
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*Name:[[:space:]]*([^[:space:]]+) ]]; then
            org_name="${BASH_REMATCH[1]}"
            domain=$(sed -n "/Name: $org_name/,/Domain:/p" "$CONFIG_FILE" | grep "Domain:" | awk '{print $2}')
            msp_id="${org_name}MSP"
            
            # Determine port based on organization
            if [[ $org_name == "MogadishuUniversity" ]]; then
                port=7051
            elif [[ $org_name == "HargeisaUniversity" ]]; then
                port=8051
            else
                port=7051
            fi
            
            cat >> "${NETWORK_DIR}/network-config/configtx.yaml" << EOF
  - &$org_name
    Name: $msp_id
    ID: $msp_id
    MSPDir: ../organizations/peerOrganizations/$domain/msp
    Policies:
      Readers:
        Type: Signature
        Rule: "OR('$msp_id.member')"
      Writers:
        Type: Signature
        Rule: "OR('$msp_id.admin')"
      Admins:
        Type: Signature
        Rule: "OR('$msp_id.admin')"
      Endorsement:
        Type: Signature
        Rule: "OR('$msp_id.member')"
    AnchorPeers:
      - Host: peer0.$domain
        Port: $port

EOF
        fi
    done < "$CONFIG_FILE"
    
    # Add orderer org
    cat >> "${NETWORK_DIR}/network-config/configtx.yaml" << EOF
  - &OrdererOrg
    Name: OrdererMSP
    ID: OrdererMSP
    MSPDir: ../organizations/ordererOrganizations/ministry.gov.so/msp
    Policies:
      Readers:
        Type: Signature
        Rule: "OR('OrdererMSP.member')"
      Writers:
        Type: Signature
        Rule: "OR('OrdererMSP.member')"
      Admins:
        Type: Signature
        Rule: "OR('OrdererMSP.admin')"
      Endorsement:
        Type: Signature
        Rule: "OR('OrdererMSP.member')"

Capabilities:
  Channel: &ChannelCapabilities
    V2_0: true
  Orderer: &OrdererCapabilities
    V2_0: true
  Application: &ApplicationCapabilities
    V2_0: true

Application: &ApplicationDefaults
  Organizations:
  Policies:
    Readers:
      Type: ImplicitMeta
      Rule: "ANY Readers"
    Writers:
      Type: ImplicitMeta
      Rule: "ANY Writers"
    Admins:
      Type: ImplicitMeta
      Rule: "MAJORITY Admins"
    LifecycleEndorsement:
      Type: ImplicitMeta
      Rule: "MAJORITY Endorsement"
    Endorsement:
      Type: ImplicitMeta
      Rule: "MAJORITY Endorsement"
  Capabilities:
    <<: *ApplicationCapabilities

Orderer: &OrdererDefaults
  OrdererType: etcdraft
  Addresses:
    - orderer.ndts.gov.so:7050
  BatchTimeout: 2s
  BatchSize:
    MaxMessageCount: 10
    AbsoluteMaxBytes: 99 MB
    PreferredMaxBytes: 512 KB
  EtcdRaft:
    Consenters:
      - Host: orderer.ndts.gov.so
        Port: 7050
        ClientTLSCert: ../organizations/ordererOrganizations/ministry.gov.so/orderers/orderer.ministry.gov.so/tls/server.crt
        ServerTLSCert: ../organizations/ordererOrganizations/ministry.gov.so/orderers/orderer.ministry.gov.so/tls/server.crt
  Organizations:
  Policies:
    Readers:
      Type: ImplicitMeta
      Rule: "ANY Readers"
    Writers:
      Type: ImplicitMeta
      Rule: "ANY Writers"
    Admins:
      Type: ImplicitMeta
      Rule: "MAJORITY Admins"
    BlockValidation:
      Type: ImplicitMeta
      Rule: "ANY Writers"
  Capabilities:
    <<: *OrdererCapabilities

Channel: &ChannelDefaults
  Policies:
    Readers:
      Type: ImplicitMeta
      Rule: "ANY Readers"
    Writers:
      Type: ImplicitMeta
      Rule: "ANY Writers"
    Admins:
      Type: ImplicitMeta
      Rule: "MAJORITY Admins"
  Capabilities:
    <<: *ChannelCapabilities

Profiles:
  EducationOrdererGenesis:
    <<: *ChannelDefaults
    Orderer:
      <<: *OrdererDefaults
      Organizations:
        - *OrdererOrg
      Capabilities: *OrdererCapabilities
    Consortiums:
      SampleConsortium:
        Organizations:
EOF

    # Add peer orgs to consortium
    while IFS= read -r line; do
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*Name:[[:space:]]*([^[:space:]]+) ]]; then
            org_name="${BASH_REMATCH[1]}"
            echo "          - *$org_name" >> "${NETWORK_DIR}/network-config/configtx.yaml"
        fi
    done < "$CONFIG_FILE"
    
    cat >> "${NETWORK_DIR}/network-config/configtx.yaml" << EOF
  
  EducationChannel:
    <<: *ChannelDefaults
    Orderer:
      <<: *OrdererDefaults
      Organizations:
        - *OrdererOrg
      Capabilities: *OrdererCapabilities
    Application:
      <<: *ApplicationDefaults
      Organizations:
EOF

    # Add peer orgs to channel profile
    while IFS= read -r line; do
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*Name:[[:space:]]*([^[:space:]]+) ]]; then
            org_name="${BASH_REMATCH[1]}"
            echo "        - *$org_name" >> "${NETWORK_DIR}/network-config/configtx.yaml"
        fi
    done < "$CONFIG_FILE"
    
    echo "✅ configtx.yaml generated"
}

function generateDockerCompose() {
    echo "🔧 Generating docker-compose.yaml from organizations.yaml..."
    
    cat > "${NETWORK_DIR}/docker/docker-compose.yaml" << EOF
version: '3.7'

services:
EOF

    # Add orderer
    cat >> "${NETWORK_DIR}/docker/docker-compose.yaml" << EOF
  orderer.ndts.gov.so:
    container_name: orderer.ndts.gov.so
    hostname: orderer.ministry.gov.so
    image: hyperledger/fabric-orderer:2.5.14
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - ORDERER_GENERAL_LISTENADDRESS=0.0.0.0
      - ORDERER_GENERAL_LISTENPORT=7050
      - ORDERER_GENERAL_BOOTSTRAPMETHOD=none
      - ORDERER_CHANNELPARTICIPATION_ENABLED=true
      - ORDERER_GENERAL_LOCALMSPID=OrdererMSP
      - ORDERER_GENERAL_TLS_ENABLED=true
      - ORDERER_GENERAL_TLS_PRIVATEFILE=/etc/hyperledger/fabric/tls/server.key
      - ORDERER_GENERAL_TLS_CERTIFICATE=/etc/hyperledger/fabric/tls/server.crt
      - ORDERER_GENERAL_TLS_ROOTCAS=[/etc/hyperledger/fabric/tls/ca.crt]
    working_dir: /opt/gopath/src/github.com/hyperledger/fabric/orderer
    command: orderer
    volumes:
      - ../organizations/ordererOrganizations/ministry.gov.so/orderers/orderer.ministry.gov.so/msp:/etc/hyperledger/fabric/msp
      - ../organizations/ordererOrganizations/ministry.gov.so/orderers/orderer.ministry.gov.so/tls:/etc/hyperledger/fabric/tls
      - ../channel-artifacts:/etc/hyperledger/fabric/channel-artifacts
    ports:
      - 7050:7050
      - 9443:9443
    networks:
      - ndts-network

EOF

    # Add peers and CAs
    peer_num=0
    ca_num=0
    while IFS= read -r line; do
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*Name:[[:space:]]*([^[:space:]]+) ]]; then
            org_name="${BASH_REMATCH[1]}"
            domain=$(sed -n "/Name: $org_name/,/Domain:/p" "$CONFIG_FILE" | grep "Domain:" | awk '{print $2}')
            msp_id="${org_name}MSP"
            
            # Add peer
            cat >> "${NETWORK_DIR}/docker/docker-compose.yaml" << EOF
  peer0.$domain:
    container_name: peer0.$domain
    image: hyperledger/fabric-peer:2.5.14
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - CORE_PEER_ADDRESS=peer0.$domain:7051
      - CORE_PEER_CHAINCODEADDRESS=peer0.$domain:7052
      - CORE_PEER_CHAINCODELISTENADDRESS=0.0.0.0:7052
      - CORE_PEER_GOSSIP_BOOTSTRAP=peer0.$domain:7051
      - CORE_PEER_GOSSIP_EXTERNALENDPOINT=peer0.$domain:7051
      - CORE_PEER_LOCALMSPID=$msp_id
      - CORE_PEER_TLS_ENABLED=true
      - CORE_PEER_TLS_CERT_FILE=/etc/hyperledger/fabric/tls/server.crt
      - CORE_PEER_TLS_KEY_FILE=/etc/hyperledger/fabric/tls/server.key
      - CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt
      - CORE_LEDGER_STATE_STATEDATABASE=CouchDB
      - CORE_LEDGER_STATE_COUCHDBCONFIG_COUCHDBADDRESS=couchdb$peer_num:5984
      - CORE_LEDGER_STATE_COUCHDBCONFIG_USERNAME=admin
      - CORE_LEDGER_STATE_COUCHDBCONFIG_PASSWORD=adminpw
    working_dir: /opt/gopath/src/github.com/hyperledger/fabric/peer
    command: peer node start
    volumes:
      - ../config/core.yaml:/etc/hyperledger/fabric/core.yaml
      - ../organizations/peerOrganizations/$domain/peers/peer0.$domain/msp:/etc/hyperledger/fabric/msp
      - ../organizations/peerOrganizations/$domain/peers/peer0.$domain/tls:/etc/hyperledger/fabric/tls
      - ../organizations/peerOrganizations/$domain/users:/etc/hyperledger/fabric/users
      - ../channel-artifacts:/etc/hyperledger/fabric/channel-artifacts
    ports:
      - $((7051 + peer_num)):7051
      - $((9444 + peer_num)):9444
    networks:
      - ndts-network

EOF

            # Add CouchDB
            cat >> "${NETWORK_DIR}/docker/docker-compose.yaml" << EOF
  couchdb$peer_num:
    container_name: couchdb$peer_num
    image: couchdb:3.3.2
    environment:
      - COUCHDB_USER=admin
      - COUCHDB_PASSWORD=adminpw
    ports:
      - $((5984 + peer_num)):5984
    networks:
      - ndts-network

EOF

            # Add CA
            cat >> "${NETWORK_DIR}/docker/docker-compose.yaml" << EOF
  ca.$domain:
    container_name: ca.$domain
    image: hyperledger/fabric-ca:1.5.17
    environment:
      - FABRIC_CA_HOME=/etc/hyperledger/fabric-ca-server
      - FABRIC_CA_SERVER_CA_NAME=ca.$domain
      - FABRIC_CA_SERVER_TLS_ENABLED=true
      - FABRIC_CA_SERVER_TLS_CERTFILE=/etc/hyperledger/fabric-ca-server-config/ca.$domain-cert.pem
      - FABRIC_CA_SERVER_TLS_KEYFILE=/etc/hyperledger/fabric-ca-server-config/priv_sk
    ports:
      - $((7054 + ca_num)):7054
    command: sh -c 'fabric-ca-server start -b admin:adminpw -d'
    volumes:
      - ../organizations/peerOrganizations/$domain/ca:/etc/hyperledger/fabric-ca-server-config
    networks:
      - ndts-network

EOF

            peer_num=$((peer_num + 1))
            ca_num=$((ca_num + 1))
        fi
    done < "$CONFIG_FILE"
    
    # Add CLI
    cat >> "${NETWORK_DIR}/docker/docker-compose.yaml" << EOF
  cli:
    container_name: cli
    image: hyperledger/fabric-tools:2.5.14
    tty: true
    stdin_open: true
    environment:
      - GOPATH=/opt/gopath
      - CORE_VM_ENDPOINT=unix:///host/var/run/docker.sock
      - FABRIC_LOGGING_SPEC=INFO
      - CORE_PEER_ID=cli
      - CORE_CHAINCODE_KEEPALIVE=10s
    working_dir: /opt/gopath/src/github.com/hyperledger/fabric/peer
    volumes:
      - /var/run/docker.sock:/host/var/run/docker.sock
      - ../organizations:/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations
      - ../channel-artifacts:/opt/gopath/src/github.com/hyperledger/fabric/peer/channel-artifacts
      - ../network-config:/opt/gopath/src/github.com/hyperledger/fabric/peer/network-config
    networks:
      - ndts-network

networks:
  ndts-network:
    driver: bridge
EOF
    
    echo "✅ docker-compose.yaml generated"
}

function main() {
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "❌ organizations.yaml not found at $CONFIG_FILE"
        echo "Please create it first with organization definitions"
        exit 1
    fi
    
    echo "🚀 Generating network configurations from organizations.yaml..."
    
    generateCryptoConfig
    generateChannelConfig
    generateDockerCompose
    
    echo "✅ All configurations generated!"
    echo "📁 Files updated:"
    echo "   - network-config/crypto-config.yaml"
    echo "   - network-config/configtx.yaml"
    echo "   - docker/docker-compose.yaml"
    echo ""
    echo "🔄 Next steps:"
    echo "   1. Run: ./scripts/generate-crypto.sh"
    echo "   2. Run: ./scripts/create-channel.sh"
    echo "   3. Run: ./scripts/deploy-chaincode.sh"
}

main "$@"
