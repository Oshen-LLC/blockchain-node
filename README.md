# Somalia National Digital Trust System (NDTS) — Blockchain Network

Hyperledger Fabric 2.5 network for the NDCSF education sector pilot. Supports certificate issuance, verification, and revocation between Mogadishu University and Hargeisa University.

## Architecture

- **Peers**: `peer0.mogadishu.university.so`, `peer0.hargeisa.university.so`
- **Orderer**: `orderer.ndts.gov.so`
- **Channel**: `education-channel`
- **Chaincode**: `certificate-chaincode` (Go)
- **State DB**: CouchDB per peer for rich queries
- **CA**: Fabric CA for identity management

## Prerequisites

- Docker & Docker Compose
- Bash (for setup scripts)
- `jq`, `wget` (used by install-fabric.sh)

## Quick Start

### Option 1: One-Click Setup (Recommended)

```bash
# 1. Install Fabric binaries
./install-fabric.sh f d b s c

# 2. One-click network setup (automates everything)
./scripts/setup-network.sh
```

### Option 2: Manual Setup

```bash
# 1. Install Fabric binaries
./install-fabric.sh f d b s c

# 2. Generate configurations from organizations.yaml
./scripts/generate-orgs.sh

# 3. Generate crypto materials
./scripts/generate-crypto.sh

# 4. Start network
docker-compose -f docker/docker-compose.yaml up -d

# 5. Create channel
./scripts/create-channel.sh

# 6. Deploy chaincode
./scripts/deploy-chaincode.sh
```

### 5. Verify Network Health

```bash
# Check peer status and channel list
docker exec peer0.mogadishu.university.so peer channel list
docker exec peer0.hargeisa.university.so peer channel list
```

## Directory Structure

```
blockchain/
├── install-fabric.sh          # Fabric binary installer
├── network-config/
│   ├── organizations.yaml    # Organization definitions (master config)
│   ├── configtx.yaml         # Channel configuration (auto-generated)
│   └── crypto-config.yaml    # Crypto material definition (auto-generated)
├── organizations/             # Generated MSP and TLS certs
├── channel-artifacts/        # Channel config blocks and tx files
├── docker/                   # Docker Compose files (auto-generated)
└── scripts/                  # Utility scripts
    ├── setup-network.sh      # One-click network setup
    ├── generate-orgs.sh      # Config generator
    └── generate-crypto.sh     # Crypto material generator
```

## Automation

### Adding New Organizations

To add a new university or organization:

1. **Edit `network-config/organizations.yaml`:**
```yaml
PeerOrgs:
  - Name: MogadishuUniversity
    Domain: mogadishu.university.so
    Type: university
    Peers: 1
    Users: 1
    
  - Name: HargeisaUniversity
    Domain: hargeisa.university.so
    Type: university
    Peers: 1
    Users: 1
    
  # Add new organization here:
  - Name: BosasoUniversity
    Domain: bosaso.university.so
    Type: university
    Peers: 1
    Users: 1
```

2. **Regenerate everything:**
```bash
# Clean existing network
./scripts/test-network.sh clean

# Regenerate configs and restart
./scripts/setup-network.sh
```

The automation will:
- Generate updated `crypto-config.yaml`
- Generate updated `configtx.yaml` 
- Generate updated `docker-compose.yaml`
- Create crypto materials for new org
- Add new peer/CA containers
- Update channel configuration
- Join new peer to channel

### Scaling Organizations

For multiple peers per organization:
```yaml
- Name: MogadishuUniversity
  Domain: mogadishu.university.so
  Type: university
  Peers: 3  # Creates peer0, peer1, peer2
  Users: 5  # Creates 5 user certificates
```

### Organization Types

- **university** - Educational institutions
- **government** - Government ministries
- **employer** - Private sector employers

Each type gets appropriate policies and access controls.

## Network Operations

### Bring Down Network

```bash
# Stop and remove containers, delete volumes
./network-config/stop.sh
```

### Restart Network

```bash
# Stop and start again (preserves ledger state)
./network-config/stop.sh
./network-config/start.sh
```

### Upgrade Chaincode

```bash
# Deploy new version (increment sequence number)
./network-config/deploy-chaincode.sh
```

## Chaincode Interaction

Once deployed, interact via the Gateway API:

```bash
# From project root
cd gateway-api
go run ./cmd/server
```

API endpoints:
- `POST /api/v1/issue` — Issue certificate
- `POST /api/v1/verify` — Verify certificate
- `GET /api/v1/certificates/:id` — Get certificate
- `POST /api/v1/revoke` — Revoke certificate

## Troubleshooting

### Common Issues

1. **Port conflicts** — Ensure ports 7050-7070, 9443-9445 are free
2. **Docker permissions** — Add user to `docker` group or use `sudo`
3. **Fabric binary path** — Add `bin/` to PATH or use `./bin/peer`

### Logs

```bash
# Peer logs
docker logs peer0.mogadishu.university.so
docker logs peer0.hargeisa.university.so

# Orderer logs
docker logs orderer.ndts.gov.so

# CA logs
docker logs ca.mogadishu.university.so
docker logs ca.hargeisa.university.so
```

### Reset Network

```bash
# Complete reset (deletes all ledger data)
./network-config/stop.sh
docker volume prune -f
rm -rf organizations/ channel-artifacts/
./network-config/start.sh
./network-config/create-channel.sh
./network-config/deploy-chaincode.sh
```

## Configuration

### Channel Configuration

Edit `network-config/configtx.yaml` to:
- Add/remove organizations
- Modify consensus (etcdraft/Kafka)
- Adjust batch/timeout settings

### Crypto Configuration

Edit `network-config/crypto-config.yaml` to:
- Change peer counts
- Modify organization names
- Update CA settings

### Docker Resources

Edit `docker/docker-compose.yaml` to:
- Adjust memory/CPU limits
- Change port mappings
- Add monitoring tools

## Development

### Local Chaincode Testing

```bash
# From chaincode directory
cd ../chaincode
go test ./...

# Build chaincode package
tar czf certificate-chaincode.tar.gz chaincode/
```

### Gateway API Development

```bash
# From gateway-api directory
make test
make lint
make build
```

## Production Considerations

- **TLS**: All components use TLS by default
- **CouchDB**: Persistent volumes for state DB
- **Orderer**: Raft consensus for HA
- **CA**: Separate CA per organization
- **Monitoring**: Prometheus metrics exposed on ports 9443-9445

## Security Notes

- Private keys (`*_sk`) are gitignored
- TLS certificates are auto-generated by Fabric CA
- MSP IDs match organization domains
- Channel policies enforce admin-only chaincode lifecycle

## Support

- Hyperledger Fabric docs: https://hyperledger-fabric.readthedocs.io/
- Gateway API docs: See `../gateway-api/README.md`
- Issues: Create GitHub issue in this repository
