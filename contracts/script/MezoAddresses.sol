// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Deployed Mezo addresses Coil depends on.
/// MUSD: npm package mezo-org/musd-contracts, deployments/ (matsnet = testnet, mainnet).
/// Pools: mezo.org/docs/developers/features/mezo-pools.
abstract contract MezoAddresses {
    struct Net {
        address bos; // BorrowerOperationsSignatures
        address troveManager;
        address priceFeed;
        address sortedTroves;
        address hintHelpers;
        address pool; // MUSD/BTC volatile basic pool
        address musd;
        address btc;
    }

    address internal constant SKIP_ORACLE = 0x7b7c000000000000000000000000000000000015;

    function testnet() internal pure returns (Net memory) {
        return Net({
            bos: 0xD757e3646AF370b15f32EB557F0F8380Df7D639e,
            troveManager: 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0,
            priceFeed: 0x86bCF0841622a5dAC14A313a15f96A95421b9366,
            sortedTroves: 0x722E4D24FD6Ff8b0AC679450F3D91294607268fA,
            hintHelpers: 0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6,
            pool: 0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9,
            musd: 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503,
            btc: 0x7b7C000000000000000000000000000000000000
        });
    }

    function mainnet() internal pure returns (Net memory) {
        return Net({
            bos: 0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a,
            troveManager: 0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193,
            priceFeed: 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88,
            sortedTroves: 0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f,
            hintHelpers: 0xD267b3bE2514375A075fd03C3D9CBa6b95317DC3,
            pool: 0x52e604c44417233b6CcEDDDc0d640A405Caacefb,
            musd: 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186,
            btc: 0x7b7C000000000000000000000000000000000000
        });
    }

    function forChain(uint256 chainId) internal pure returns (Net memory) {
        if (chainId == 31611) return testnet();
        if (chainId == 31612) return mainnet();
        revert("Coil: unsupported chain");
    }
}
