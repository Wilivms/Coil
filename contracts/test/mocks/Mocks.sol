// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IPoolCallee} from "../../src/interfaces/IMezo.sol";

Vm constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// Mezo's BTC ERC-20 precompile: an ERC-20 view over native balances.
/// `transfer` moves native BTC without calling the recipient (like the real precompile).
contract MockBTCPrecompile {
    string public constant symbol = "BTC";
    uint8 public constant decimals = 18;

    function balanceOf(address a) external view returns (uint256) {
        return a.balance;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(msg.sender.balance >= amount, "BTC: balance");
        VM.deal(msg.sender, msg.sender.balance - amount);
        VM.deal(to, to.balance + amount);
        return true;
    }
}

contract MockMUSD {
    string public constant symbol = "MUSD";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public minter;

    constructor() {
        minter = msg.sender;
    }

    function setMinter(address m) external {
        minter = m;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter || minter == address(0), "MUSD: minter");
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == minter, "MUSD: minter");
        require(balanceOf[from] >= amount, "MUSD: burn exceeds balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "MUSD: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockFactory {
    uint256 public fee = 30; // 0.30%

    function getFee(address, bool) external view returns (uint256) {
        return fee;
    }

    function setFee(uint256 f) external {
        fee = f;
    }
}

/// Same swap/hook/K logic as Mezo's Aerodrome-style Pool.sol (volatile curve only).
contract MockPool {
    address public immutable token0;
    address public immutable token1;
    address public immutable factory;
    bool public constant stable = false;
    uint256 public reserve0;
    uint256 public reserve1;
    address public constant FEES = address(0xFEE5);
    bool private _locked;

    constructor(address t0, address t1, address f) {
        token0 = t0;
        token1 = t1;
        factory = f;
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (reserve0, reserve1, block.timestamp);
    }

    function sync() external {
        reserve0 = IBal(token0).balanceOf(address(this));
        reserve1 = IBal(token1).balanceOf(address(this));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(!_locked, "reentrancy");
        _locked = true;
        require(amount0Out > 0 || amount1Out > 0, "InsufficientOutputAmount");
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        require(amount0Out < r0 && amount1Out < r1, "InsufficientLiquidity");
        if (amount0Out > 0) IBal(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IBal(token1).transfer(to, amount1Out);
        if (data.length > 0) IPoolCallee(to).hook(msg.sender, amount0Out, amount1Out, data);
        uint256 b0 = IBal(token0).balanceOf(address(this));
        uint256 b1 = IBal(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "InsufficientInputAmount");
        uint256 fee = MockFactory(factory).fee();
        if (in0 > 0) IBal(token0).transfer(FEES, (in0 * fee) / 10_000);
        if (in1 > 0) IBal(token1).transfer(FEES, (in1 * fee) / 10_000);
        b0 = IBal(token0).balanceOf(address(this));
        b1 = IBal(token1).balanceOf(address(this));
        require(b0 * b1 >= r0 * r1, "K");
        (reserve0, reserve1) = (b0, b1);
        _locked = false;
    }
}

interface IBal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract MockPriceFeed {
    uint256 public price;

    constructor(uint256 p) {
        price = p;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function fetchPrice() external view returns (uint256) {
        return price;
    }
}

/// BorrowerOperationsSignatures + TroveManager in one mock.
/// Signature hashing mirrors mezo-org/musd BorrowerOperationsSignatures.sol exactly
/// (OZ EIP712, domain "BorrowerOperationsSignatures" v1, packed typehash|data|nonce|deadline).
contract MockTroves {
    struct Trove {
        uint256 coll;
        uint256 principal;
        uint256 interest;
        uint256 status;
    }

    bytes32 public constant OPEN_TROVE_TYPEHASH = keccak256(
        "OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant ADJUST_TROVE_TYPEHASH = keccak256(
        "AdjustTrove(uint256 collWithdrawal,uint256 debtChange,bool isDebtIncrease,uint256 assetAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant CLOSE_TROVE_TYPEHASH =
        keccak256("CloseTrove(address borrower,address recipient,uint256 nonce,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 public constant MCR = 1.1e18;
    uint256 public constant GAS_COMP = 200e18;
    uint256 public constant MIN_NET_DEBT = 1800e18;
    uint256 public constant BORROW_FEE = 1e15; // 0.1%

    MockMUSD public immutable musd;
    MockPriceFeed public immutable priceFeed;
    mapping(address => Trove) public troves;
    mapping(address => uint256) public nonces;

    constructor(MockMUSD _musd, MockPriceFeed _pf) {
        musd = _musd;
        priceFeed = _pf;
    }

    // ---- signature helpers (same as OZ EIP712Upgradeable._hashTypedDataV4)
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("BorrowerOperationsSignatures"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function _verify(bytes32 typeHash, bytes memory data, address borrower, bytes memory sig, uint256 deadline)
        internal
    {
        require(block.timestamp <= deadline, "Signature expired");
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, data, nonces[borrower], deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        require(sig.length == 65, "sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        require(ecrecover(digest, v, r, s) == borrower, "BorrowerOperationsSignatures: Invalid signature");
        nonces[borrower]++;
    }

    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    // ---- BorrowerOperationsSignatures
    function openTroveWithSignature(
        uint256 debtAmount,
        address,
        address,
        address borrower,
        address recipient,
        bytes memory signature,
        uint256 deadline
    ) external payable {
        _verify(OPEN_TROVE_TYPEHASH, abi.encode(msg.value, debtAmount, borrower, recipient), borrower, signature, deadline);
        require(troves[borrower].status != 1, "BorrowerOps: Trove is active");
        uint256 fee = (debtAmount * BORROW_FEE) / 1e18;
        require(debtAmount + fee >= MIN_NET_DEBT, "BorrowerOps: Trove's net debt must be greater than minimum");
        uint256 composite = debtAmount + fee + GAS_COMP;
        require(_icr(msg.value, composite) >= MCR, "BorrowerOps: An operation that would result in ICR < MCR is not permitted");
        troves[borrower] = Trove(msg.value, composite, 0, 1);
        musd.mint(recipient, debtAmount);
    }

    function closeTroveWithSignature(address borrower, address recipient, bytes memory signature, uint256 deadline)
        external
    {
        _verify(CLOSE_TROVE_TYPEHASH, abi.encode(borrower, recipient), borrower, signature, deadline);
        Trove memory t = troves[borrower];
        require(t.status == 1, "BorrowerOps: Trove does not exist or is closed");
        uint256 debt = t.principal + t.interest;
        musd.burn(msg.sender, debt - GAS_COMP);
        delete troves[borrower];
        troves[borrower].status = 2;
        (bool ok,) = recipient.call{value: t.coll}("");
        require(ok, "Sending BTC failed");
    }

    function adjustTroveWithSignature(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address,
        address,
        address borrower,
        address recipient,
        bytes memory signature,
        uint256 deadline
    ) external payable {
        _verify(
            ADJUST_TROVE_TYPEHASH,
            abi.encode(collWithdrawal, debtChange, isDebtIncrease, msg.value, borrower, recipient),
            borrower,
            signature,
            deadline
        );
        require(!isDebtIncrease && msg.value == 0, "mock: deleverage only");
        Trove storage t = troves[borrower];
        require(t.status == 1, "BorrowerOps: Trove does not exist or is closed");
        musd.burn(msg.sender, debtChange);
        // repay interest first, then principal (like MUSD)
        uint256 fromInterest = debtChange > t.interest ? t.interest : debtChange;
        t.interest -= fromInterest;
        t.principal -= debtChange - fromInterest;
        t.coll -= collWithdrawal;
        require(t.principal + t.interest - GAS_COMP >= MIN_NET_DEBT, "BorrowerOps: Trove's net debt must be greater than minimum");
        require(_icr(t.coll, t.principal + t.interest) >= MCR, "BorrowerOps: An operation that would result in ICR < MCR is not permitted");
        (bool ok,) = recipient.call{value: collWithdrawal}("");
        require(ok, "Sending BTC failed");
    }

    // ---- TroveManager
    function getEntireDebtAndColl(address b)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        Trove memory t = troves[b];
        return (t.coll, t.principal, t.interest, 0, 0, 0);
    }

    function getTroveStatus(address b) external view returns (uint256) {
        return troves[b].status;
    }

    function accrueInterest(address b, uint256 amount) external {
        troves[b].interest += amount;
    }

    function _icr(uint256 coll, uint256 debt) internal view returns (uint256) {
        return (coll * priceFeed.fetchPrice()) / debt;
    }
}
