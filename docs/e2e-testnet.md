# End-to-end run on Mezo testnet (4 Nov 2026)

Every CoilRouter v3 flow, live, in one sitting: `cd keeper && E2E_PRIVATE_KEY=0x... npm run e2e`.
Wallet `0x329A…34ab`, BTC at 80,2xx (MUSD PriceFeed), not in Recovery Mode. Each protection was armed already due;
the always-on keeper (GitHub Actions, wallet `0x09b6…e2A1`) fired **all three on its own** before the script's
fallback timer ran out.

| # | Step | By | Tx |
|---|---|---|---|
| 1 | coil (0.03 BTC → 0.066 BTC trove, 2.2×) | user | [`0x30d165e7…`](https://explorer.test.mezo.org/tx/0x30d165e770f796bd3cb1a0a6e546a7867e1940e36e5a2c5265c8c4e281393fc9) |
| 2 | depositReserve (MUSD into sMUSD) | user | [`0xfd156346…`](https://explorer.test.mezo.org/tx/0xfd156346da66d7f1e9d02e29632b4310cfb71e47025964c0a55a6d54c4088e70) |
| 3 | armShield (repay 100 MUSD, due now) | user | [`0x74f1587b…`](https://explorer.test.mezo.org/tx/0x74f1587bebfa9980a7aef640e770ca53933d2f5dae5147745685b394ad13780a) |
| 4 | **fireShield** | **keeper** | [`0xc5d1d4c2…`](https://explorer.test.mezo.org/tx/0xc5d1d4c2bdb380496faf75bcc4e6401b3ae50483c61492fe46c83cc68fbdde53) |
| 5 | relever (+0.01 BTC) | user | [`0x846f58cb…`](https://explorer.test.mezo.org/tx/0x846f58cb8b5798d13b6cb22ade5b963865fc44cc40472a5563b0a13327d9fdca) |
| 6 | armRecoil (trigger at MCR) | user | [`0x4ae8f7a0…`](https://explorer.test.mezo.org/tx/0x4ae8f7a04380b29c55eeebcfb04761678aa9677755c98f5aaa5c967a5f1d946f) |
| 7 | **fireRecoil** (+0.005 BTC) | **keeper** | [`0xc6176c4a…`](https://explorer.test.mezo.org/tx/0xc6176c4aa4fab70e6f65d9efe99448ba1f77d3680362968ff51f3e9d23ab5b6b) |
| 8 | armGuard (repay 300 MUSD, minBtcOut signed) | user | [`0x208cfccb…`](https://explorer.test.mezo.org/tx/0x208cfccb3cb20f4bc3a9e07b73c82821d42fbce9bee011b5dba2e0ad4b00513a) |
| 9 | **fireGuard** | **keeper** | [`0x5908cbdf…`](https://explorer.test.mezo.org/tx/0x5908cbdf292679bfda8edca549cf68859d68c3cb84dfbd93d4907aa17647265d) |
| 10 | deleverage (repay 200 MUSD) | user | [`0x98dff4e4…`](https://explorer.test.mezo.org/tx/0x98dff4e42f4855fd33465677763445b2bf74d474eb8888e6df197e3c3119795a) |
| 11 | pushIncentives (MUSD → MUSD/BTC gauge) | anyone | [`0x98b623f3…`](https://explorer.test.mezo.org/tx/0x98b623f36576c9242b9f03af6a5464ef30c6757840c61104b407d70962ca22ae) |
| 12 | withdrawReserve (yield included) | user | [`0xb1459cd6…`](https://explorer.test.mezo.org/tx/0xb1459cd64a2e730722bfb143bd86cf90857ba8ed6d435d5b4540dc778cb57d33) |
| 13 | unwind (trove closed, BTC back) | user | [`0x6d4366f4…`](https://explorer.test.mezo.org/tx/0x6d4366f4eb14fb095204b603bddd02f9ac268f1345aee9613f3c8c37fd4c0fc4) |

Result: trove opened, protected three ways, levered up twice, partly deleveraged and closed; the router ended with 0 BTC
and 0 loose MUSD (invariants R5/R6 hold on-chain too).

## Found by this run

The first `relever` attempt ([`0xcc6e…50bd`](https://explorer.test.mezo.org/tx/0xcc6e3448e169c6e54b7576817567e26fb4826507077cb85c9bfd82b0d28e50bd)) passed
simulation and then reverted on-chain: with zero hints MUSD's SortedTroves walks the 350-trove list, and the bare gas
estimate left an inner call short (63/64 rule). Fixed: the keeper and this script now send 1.5× the estimate; the app
already computes real insert hints (`insertHints` in `app/src/lib/actions.ts`).

## v4 run (11 Nov 2026): the pool 5.5% off the oracle

On 10 Nov the testnet MUSD/BTC pool priced BTC 5.5% above MUSD's PriceFeed, past the 5% owner cap: v3 refused every
coil and every leverage-up, for everyone. v4 (`0x17e0…7F03`) lets a borrower accept a wider gap for a trade **they send
themselves** (`deviationBps`, at most 20%, the app sets it from the live quote and shows it before signing). Keeper-fired
flows never get that choice. Same wallet, same script (`npm run e2e`), with the gap still there:

| # | Step | Tx |
|---|---|---|
| 1 | coil at a 5.5% pool/oracle gap (own tolerance 7.5%) | [`0x936fa5b7…`](https://explorer.test.mezo.org/tx/0x936fa5b7dc50db1a97bdec55eb1e3dc07267deca43dae8b696700b56fcb2a7ea) |
| 2 | depositReserve | [`0x792cfe2f…`](https://explorer.test.mezo.org/tx/0x792cfe2f555f1a32f978bb98c2327db4d9ee4da78cec26dc9321074188445cfd) |
| 3 | armShield | [`0x67e4e76f…`](https://explorer.test.mezo.org/tx/0x67e4e76fefe50f182bf792c13f4822784381ace9cf904857d337da13f43b3291) |
| 4 | fireShield | [`0x2b612f5f…`](https://explorer.test.mezo.org/tx/0x2b612f5f6041a62adceaae7d6ab21041d0fd445d9ef8ce0a748da8f2dabee075) |
| 5 | relever at the same gap (own tolerance 7.5%) | [`0x053a71c3…`](https://explorer.test.mezo.org/tx/0x053a71c309604334e58598c3d1027176beed73f93148bc2937b4bcd5336c4768) |
| 6 | armRecoil | [`0x0a1c8691…`](https://explorer.test.mezo.org/tx/0x0a1c86910c6d5b36ae42f49a74f016ede85ce83c067e866b519d8bca80f453a3) |
| 7 | fireRecoil **refused** by the 3% bound: a keeper may not buy BTC 5.5% dear for the user | — |
| 8 | disarmRecoil | [`0xe2d7843a…`](https://explorer.test.mezo.org/tx/0xe2d7843ad4c9a36244b02508b1ce73385d8b80c6037523950f4020c66bef599d) |
| 9 | armGuard | [`0xd857d9b7…`](https://explorer.test.mezo.org/tx/0xd857d9b7f76c3df126e3f8245448911b9416d2e60ccbdfab14682d6155fc77b8) |
| 10 | fireGuard (selling BTC into a pool where it is dear: within the bound) | [`0xb5a843f8…`](https://explorer.test.mezo.org/tx/0xb5a843f837c5c19a7040d72891ae7b8c949955190926c43f4987440bfda3a67c) |
| 11 | deleverage | [`0xc3c957c7…`](https://explorer.test.mezo.org/tx/0xc3c957c78d6da562bd9cfea3f90617ddec95f4d36212b3b1729a8b8252bb1ab7) |
| 12 | pushIncentives | [`0xd88e5252…`](https://explorer.test.mezo.org/tx/0xd88e52521cb669b77e63361ca9b579aba0c22ceadaf1788db7dccfca39aa6c69) |
| 13 | withdrawReserve | [`0x61bb3d19…`](https://explorer.test.mezo.org/tx/0x61bb3d19416c24b1349b4c16e8529a3f7af2c1a9786b00faa511038f02587f1d) |
| 14 | unwind | [`0x621863b3…`](https://explorer.test.mezo.org/tx/0x621863b3f004f20decbc5dc0eda568fd56497652462a1b7682e9e3f45da290e9) |

Two more things this run found and fixed in the keeper and the script: the RPC once estimated 32,742 gas for a
`fireShield` that used 4.7M (hintless SortedTroves walk), so sends now use a 1.5M floor; and 1.5× a large estimate can
pass Mezo's 10M block limit, so sends are capped at 9.5M.

## v4 run with insert hints (11 Nov 2026, 05:15 CET)

Same 14 steps, now with SortedTroves insert hints from MUSD's HintHelpers on every call (keeper and script; the app
already had them). The keeper fired the Shield and the Guard on its own; the Recoil was refused by the 3% bound again
(pool still ~6% off the oracle).

| Step | Tx |
|---|---|
| coil | [`0xc31acdd3…`](https://explorer.test.mezo.org/tx/0xc31acdd3b70752de3c50a8444b068f38342310687a19de9b5cfb1d9124be24b8) |
| fireShield (keeper) | [`0x545502b1…`](https://explorer.test.mezo.org/tx/0x545502b160ec07db691e97463ff49017f53e1661453ad071a7737cfcc075f70a) |
| relever | [`0x62d53d04…`](https://explorer.test.mezo.org/tx/0x62d53d042644ab677e2e6cf79204154205f8e5c79722e402906c0c8e02a47bcf) |
| fireRecoil | refused by the oracle bound, then `disarmRecoil` [`0xc2dfe03e…`](https://explorer.test.mezo.org/tx/0xc2dfe03e56e228ef4e76b1b79dfba2039429c17656e140b0c6e7ed5fbbf36e92) |
| fireGuard (keeper) | [`0xfc469bdb…`](https://explorer.test.mezo.org/tx/0xfc469bdbef91d731278a850da5b7e0c6e5266df487d2303973ba876201cfe513) |
| deleverage | [`0x3f24338b…`](https://explorer.test.mezo.org/tx/0x3f24338b3f85d5c3eb4e497d0a445a402f1ff0cfb03a7006cb9623dfe95f36d4) |
| unwind | [`0xdf119fff…`](https://explorer.test.mezo.org/tx/0xdf119fff7c9bee3d22099876a92280a57715fc549e76540786c0a780090fcb3f) |

Mezo charges at least half of a transaction's gas limit, so with hints in place the send floor drops from 1.5M to 600k.

