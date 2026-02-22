# Hako Labs - Contracts

Smart contracts for Hako stable-asset vaulting and multichain gateway execution.

## Official Links

- [Documentation](https://hako.gitbook.io/docs/)
- [Web](https://hakolabs.app/)
- [DApp](http://app.hakolabs.app/)
- [Dune Dashboard (soon)]()
- [DefiLlama](https://defillama.com/protocol/hako)

This repo contains:
- `HakoStableVault` (home-chain canonical LP accounting)
- `HakoStableGateway` (remote-chain custody and payout gateway)
- UUPS proxy deployment via Hardhat Ignition modules
- test suites for accounting, security roles, replay protection, and external vault flows

## What Is Hako?

Hako is a multichain stable-asset yield protocol.

Core model:
- Users can deposit supported stablecoins on available chains.
- Canonical accounting and LP ownership live on the home vault (`HakoStableVault`, target chain: Base).
- Remote EVM chains use `HakoStableGateway` for custody, local deposit intake, and withdrawal payout execution.

## Quick Start

Install dependencies:

```bash
npm i
```

Build and test:

```bash
npm run compile
npm run lint:sol
npm run test
```

## Environment Variables

Create `.env` in this folder. Main variables used by scripts/config:

- `DEPLOYER_PRIVATE_KEY`
- `ETHERSCAN_API_KEY` (optional for verification)
- `HAKO_STABLE_VAULT_PROXY` (for upgrade/scan scripts only)
- `RPC_URL_ETHEREUM`
- `RPC_URL_BASE`
- `RPC_URL_OPTIMISM`
- `RPC_URL_ARBITRUM`
- `RPC_URL_POLYGON`
- `RPC_URL_HYPEREVM`
- `RPC_URL_MONAD`

## Deployment and Upgrade

### Deployment (Hardhat Ignition)

Ignition supports upgradeable deployments by deploying:
1. implementation contract
2. `HakoProxy` (`ERC1967Proxy`) with encoded initializer calldata

This repository uses that atomic pattern in both modules:
- `ignition/modules/HakoStableVault.ts`
- `ignition/modules/HakoStableGateway.ts`

#### 1) Prepare parameters

Vault params example: `ignition/parameters/stable-base.json`

Gateway params example: `ignition/parameters/stable-gateway-base.json`

Edit values for your target chain before deploying.

#### 2) Deploy HakoStableVault

```bash
npx hardhat ignition deploy ignition/modules/HakoStableVault.ts --network base --parameters ignition/parameters/stable-base.json
```

#### 3) Deploy HakoStableGateway

```bash
npx hardhat ignition deploy ignition/modules/HakoStableGateway.ts --network arbitrum --parameters ignition/parameters/stable-gateway-arbitrum.json
```

## Address Registry

Use proxy addresses for integrations

| Network  | Contract          | Proxy                                        | Implementation                               |
|----------|-------------------|----------------------------------------------|----------------------------------------------|
| Base     | HakoStableVault   | `0xda6600Dd3124f07EC82304b059248e5b529864df` | `0x20876Db1eb22CEb46103eCE5D750B2B73Fe53031` |
| Ethereum | HakoStableGateway | `0xd69c7F2bd840B16685BA13d5Bb213AD300a873B1` | `0xC6EBC060127977eAfF215805d220d3E0ff40B9d4` |
| Optimism | HakoStableGateway | `0xDa413E4F6a7E9c9C3f9C366109C34e5A5238af14` | `0x3769BAbd61dc3b91883a033b44F84b15af08C772` |
| Arbitrum | HakoStableGateway | `0x69BBbF4dbc599f26518A3F73419d2D43442218e6` | `0x10A5024DDa34CB09C7b3FBE5e4B5454AF4a21E11` |
| Polygon  | HakoStableGateway | `0xeA7E3366be916c0A9aa5541cBe0cf788538966D6` | `0xE93eA7498202698a2ecbbe83c235685950A47D32` |

## Security and Audit Status


The current contract set in this repository is in the pre-public-audit stage.  
An independent third-party smart contract audit is pending, and this section will be updated with formal audit reports once completed.

Until audit results are published:
- treat this release as an active development/integration build
- perform your own risk review before any production use
- report vulnerabilities through the responsible disclosure channel listed in the Official Links section

### Reports

- **Audit Agent:** [pdf](./audit/audit_agent_report.pdf)
