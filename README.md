# Coil

**Leveraged Bitcoin on Mezo in one signature.**

Coil opens a leveraged MUSD trove in a single transaction. It flash-borrows BTC from Mezo's own MUSD/BTC pool, opens the trove **in the user's name** through MUSD's EIP-712 `BorrowerOperationsSignatures`, and repays the pool with the MUSD the trove just minted. The same trick runs in reverse to unwind or deleverage, and it powers **Guard**, a pre-signed stop-loss that any keeper can execute when BTC falls to a trigger price.

Built for the [Mezo Buildathon](https://app.akindo.io/wave-hacks/OVOO0gdrVU8379D10), Track 1 (DeFi).

| Looping by hand to 3× | With Coil |
|---|---|
| 1 open + 6 loops × (borrow, approve, swap, deposit) = **25 transactions**, 6 pool fees, exposed between steps | **1 signature + 1 transaction**, 1 swap, atomic |

## Why it is deep on Mezo

Coil only works because of three Mezo primitives, used together:

1. **Mezo Pools flash swaps.** The Aerodrome-style `Pool.swap()` sends tokens first, calls `hook()` on the receiver, then checks the invariant. Coil uses the MUSD/BTC volatile pool as its flash lender and its exact-out curve as the quote.
2. **MUSD signature operations.** `openTroveWithSignature`, `closeTroveWithSignature` and `adjustTroveWithSignature` let a contract supply collateral and pay debt for a borrower who signed. The trove is never owned by Coil.
3. **BTC is native gas and an ERC-20 precompile** (`0x7b7c…0000`) over the same balance, so BTC received from the pool is forwarded as `msg.value` collateral without wrapping.

## Features

| | What it does | Where |
|---|---|---|
| **Coil** | Open at a target leverage in one tx; leftover MUSD buffer refunded | `CoilRouter.coil` |
| **Unwind** | Close the whole trove in one tx and get net BTC back | `CoilRouter.unwind` |
| **Deleverage** | Repay part of the debt with a flash swap, sell only the BTC needed | `CoilRouter.deleverage` |
| **Guard** | Store a signed partial deleverage + trigger; any keeper fires it for a bounty once MUSD's `PriceFeed` ≤ trigger. Stale-signature detection on-chain | `armGuard` / `fireGuard` / `guardStatus`, `keeper/` |
| **Risk cockpit** | Liquidation odds (GBM first-passage) on 7/30/90 days, empirical odds from every window since 2019, a 220-path Monte Carlo field, history replay | `app/src/lib/risk.ts` |
| **Redemption radar** | Reads every trove on Mezo and shows how much MUSD must be redeemed before yours is touched | `app/src/lib/live.ts` |
| **Live market** | Oracle price, pool depth, fixed rate, system TCR, recovery mode, read every 15 s | `useMarket` |

## Repository

```
contracts/   Foundry project: CoilRouter, Mezo interfaces, tests, fork test, deploy script
app/         Vite + React + wagmi/viem front end (landing + app)
keeper/      Guard keeper (viem), anyone can run it and earn the bounty
```

## Contracts

```bash
cd contracts
forge test                                   # 21 tests incl. fuzzed open→close round trips
forge test --match-path "test/fork/*" --fork-url mezo_testnet -vv   # real MUSD + real pool on Mezo testnet
```

- `test/mocks/Mocks.sol` mirrors the Mezo pool's swap/hook/K logic and MUSD's signature hashing exactly; the mocks verify real EIP-712 signatures.
- `test/SignatureCompat.t.sol` proves that the digests viem produces in the app equal what `BorrowerOperationsSignatures` computes.
- The fork test swaps in emulators only for the two chain precompiles a local fork cannot run (BTC token and Skip oracle). Everything else is the deployed bytecode.

### Deploy (Mezo testnet)

```bash
cd contracts
cast wallet import coil-deployer --interactive    # once; your key is stored encrypted
forge script script/Deploy.s.sol --rpc-url mezo_testnet --account coil-deployer --broadcast
```

Then put the printed address in `app/.env`:

```bash
cp app/.env.example app/.env   # VITE_COIL_ROUTER=0x...
```

Test BTC: [faucet.test.mezo.org](https://faucet.test.mezo.org/). A trove needs at least 1,800 MUSD of debt, so at 3× deposit about 0.012 BTC or more.

## App

```bash
cd app
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in app/dist (deploy to Vercel / Netlify)
```

Without `VITE_COIL_ROUTER` the app runs in preview mode: every quote, ratio, probability and the radar are computed from live Mezo testnet data, and the trade buttons explain what is missing.

## Keeper

```bash
cd keeper && npm install
COIL_ROUTER=0x... KEEPER_PRIVATE_KEY=0x... npm start    # or DRY_RUN=1 to only watch
```

## Safety notes

- The router never holds funds between transactions; every flow is checked by balance deltas and tests assert a zero balance after each one.
- `receive()` rejects BTC outside a running flow, so a signature replayed directly against MUSD with Coil as recipient reverts instead of stranding collateral.
- The UI refuses plans under 115% after price impact (MUSD's minimum is 110%).
- Guard signatures authorise one exact adjustment with Coil as recipient. Any other trove operation bumps the MUSD nonce and makes it stale (`guardStatus` reports it).
- Unaudited hackathon code on testnet.

## Roadmap (Wave 2)

- Re-leverage and leverage changes on an existing trove (`adjustTroveWithSignature` with `isDebtIncrease`).
- Guard ladders: several triggers, each a smaller deleverage.
- Coil Risk API: liquidation odds and redemption cover as a paid x402 endpoint in MUSD (Track 2).
- Mezo Passport for Bitcoin-native wallets.
- Optional protocol fee (capped at 0.5%, already in the contract, off by default).
