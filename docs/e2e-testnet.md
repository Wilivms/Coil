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
