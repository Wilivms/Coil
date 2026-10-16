# AKINDO submission: Coil

- **Product name:** Coil
- **Tagline:** Leveraged Bitcoin on Mezo in one signature: a flash swap from Mezo's MUSD/BTC pool opens a MUSD trove in your name, and Guard, a pre-signed stop-loss, protects it.
- **Product type:** Functional
- **Live demo:** https://wilivms.github.io/Coil/
- **Build with:** Mezo, MUSD
- **Category:** DeFi
- **Tags:** Solidity, Foundry, EIP-712, React, viem, wagmi
- **Video:** (to add)

## TL;DR
Coil opens a leveraged MUSD trove on Mezo in one signature, using a flash swap from Mezo's own MUSD/BTC pool, and protects it with Guard, a pre-signed stop-loss any keeper can execute.

**Category:** leveraged BTC borrowing (looping)
**Track:** Track 1 (DeFi)
**Chain:** Mezo testnet. CoilRouter `0x46a1B46016cF0C0E328Aa5D304F2f11257B21A16`
**Status:** entirely new, built during the Buildathon
**Readiness:** testnet deployment, live app

## How it works
Looping BTC into MUSD by hand to reach 3x takes about 25 transactions (open, then borrow, approve, swap, deposit six times), pays six pool fees and leaves the user exposed between steps.

With Coil the user signs one EIP-712 message and sends one transaction. CoilRouter flash-borrows BTC from Mezo's MUSD/BTC pool, opens the trove in the user's name through MUSD's `openTroveWithSignature`, and repays the pool with the MUSD the trove just minted. Coil never owns the trove. The same path runs in reverse to unwind or deleverage in one transaction.

**Guard:** the user signs a partial deleverage and a trigger price once. When MUSD's own price feed reaches the trigger, any keeper can fire it for a small BTC bounty, before liquidation can.

The app adds a risk cockpit (liquidation odds, Monte Carlo, historical replay), a redemption radar that reads every trove on Mezo, and an on-chain activity feed with explorer links.

**MUSD/MEZO usage:** MUSD is the debt asset and the pool's quote asset. Every Coil position mints MUSD and trades through Mezo's own pool. It relies on three Mezo primitives together: pool flash swaps, MUSD signature operations, and native BTC as an ERC-20 precompile.

## Target group
BTC holders on Mezo or in DeFi who want leveraged BTC exposure without selling, intermediate to advanced users, desktop and mobile web, worldwide.

## Tech stack
Solidity 0.8.24, Foundry (unit, fuzz and fork tests against the live MUSD contracts), EIP-712, Mezo pools, MUSD BorrowerOperationsSignatures. React, Vite, wagmi, viem, RainbowKit, GSAP, WebGL. A viem keeper for Guard.

## Future milestones
1. Wave 2 (November 2026): re-leverage an open trove, Guard ladders with several triggers, a risk API over x402 paid in MUSD.
2. Early 2027: security audit.
3. 2027: mainnet with the fee switch, Mezo Passport for Bitcoin wallets.

## Links
- Live app: https://wilivms.github.io/Coil/
- Code: https://github.com/Wilivms/Coil
- Deck: https://claude.ai/artifact/JL1ftrsR7CE3GFppdADLHd

## Team
Wiliams Lopes: solo builder, Head of Events at De Vinci Blockchain, ESILV Paris. LinkedIn: https://www.linkedin.com/in/wiliams-lopes-3382921ba/
