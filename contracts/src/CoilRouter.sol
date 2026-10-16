// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    IERC20Min,
    IMezoPool,
    IMezoPoolFactory,
    IPoolCallee,
    IBorrowerOperationsSignatures,
    ITroveManager,
    IPriceFeed
} from "./interfaces/IMezo.sol";

/// @title CoilRouter
/// @notice Leveraged BTC on Mezo in one transaction, without ever taking custody of the trove.
///
///         Coil (open):   flash-swap BTC out of the MUSD/BTC pool -> open the user's trove with
///                        deposit + flashed BTC via `openTroveWithSignature` -> pay the pool back
///                        with the MUSD the trove just minted. Leftover MUSD goes to the user.
///         Unwind:        flash-swap MUSD -> `closeTroveWithSignature` repays the debt and sends the
///                        collateral here -> pay the pool in BTC -> send the rest to the user.
///         Deleverage:    same as unwind but partial, through `adjustTroveWithSignature`.
///         Guard:         the user pre-signs a deleverage and a trigger price. Anyone can execute it
///                        once MUSD's own price feed is at or below the trigger, for a small bounty.
///
/// @dev    Mezo specifics this contract relies on:
///         - BTC is the native coin AND an ERC-20 precompile (0x7b7c…0000) over the same balance, so
///           BTC received from the pool can be forwarded as `msg.value`, and BTC is paid to the pool
///           with an ERC-20 `transfer`.
///         - The trove always belongs to the signer (`borrower`); Coil is only the `recipient` of
///           the MUSD / collateral that it needs to settle the flash swap within the same tx.
///         - BTC arriving by native call (collateral from MUSD's ActivePool) is only accepted while a
///           flow is running, so a signature used directly against MUSD cannot strand funds here.
contract CoilRouter is IPoolCallee {
    // ---------------------------------------------------------------- constants

    uint8 private constant IDLE = 1;
    uint8 private constant OPEN = 2;
    uint8 private constant CLOSE = 3;
    uint8 private constant DELEVER = 4;

    /// MUSD gas compensation held in the GasPool for every trove (LiquityBase.MUSD_GAS_COMPENSATION).
    uint256 public constant GAS_COMPENSATION = 200e18;
    /// Extra MUSD flashed on close to absorb interest rounding; refunded to the user.
    uint256 public constant CLOSE_BUFFER = 1e15;
    uint256 public constant MAX_FEE_BPS = 50; // 0.50% cap on the protocol fee
    uint256 public constant MAX_BOUNTY_BPS = 200; // 2.00% cap on a Guard keeper bounty

    // ---------------------------------------------------------------- immutables

    IBorrowerOperationsSignatures public immutable bos;
    ITroveManager public immutable troveManager;
    IPriceFeed public immutable priceFeed;
    IMezoPool public immutable pool;
    IMezoPoolFactory public immutable poolFactory;
    address public immutable musd;
    address public immutable btc;
    bool public immutable musdIsToken0;

    // ---------------------------------------------------------------- storage

    address public owner;
    address public treasury;
    uint16 public feeBps;

    uint8 private _flow = IDLE;

    struct Guard {
        uint128 triggerPrice; // BTC/USD, 18 decimals
        uint128 collWithdrawal; // BTC the signed adjustment withdraws
        uint128 debtRepay; // MUSD the signed adjustment repays
        uint64 deadline; // signature deadline
        uint16 bountyBps; // share of the released BTC paid to the keeper
        uint64 nonce; // MUSD signature nonce the signature was made for (staleness check)
        bytes signature; // EIP-712 AdjustTrove signature, recipient = this contract
    }

    mapping(address => Guard) private _guards;

    // ---------------------------------------------------------------- events

    event Coiled(
        address indexed user,
        uint256 deposit,
        uint256 totalColl,
        uint256 debtAmount,
        uint256 flashBtc,
        uint256 musdPaidToPool,
        uint256 musdRefund
    );
    event Unwound(address indexed user, uint256 musdRepaid, uint256 btcOut);
    event Delevered(address indexed user, uint256 collWithdrawn, uint256 debtRepaid, uint256 btcOut);
    event GuardArmed(
        address indexed user,
        uint256 triggerPrice,
        uint256 collWithdrawal,
        uint256 debtRepay,
        uint256 bountyBps,
        uint256 deadline
    );
    event GuardDisarmed(address indexed user);
    event GuardFired(
        address indexed user, address indexed keeper, uint256 price, uint256 btcToUser, uint256 bounty
    );
    event FeeChanged(uint256 feeBps);
    event TreasuryChanged(address treasury);
    event OwnerChanged(address owner);

    // ---------------------------------------------------------------- errors

    error Busy();
    error Unauthorized();
    error BadPool();
    error NothingToFlash();
    error DebtTooSmall(uint256 debtAmount, uint256 musdOwed);
    error InsufficientLiquidity();
    error NoDebt();
    error CollateralShort(uint256 btcAvailable, uint256 btcOwed);
    error Slippage(uint256 btcOut, uint256 minBtcOut);
    error NoGuard();
    error GuardExpired();
    error NotTriggered(uint256 price, uint256 triggerPrice);
    error BadParam();
    error UnexpectedBtc();
    error TransferFailed();

    // ---------------------------------------------------------------- setup

    constructor(
        address _bos,
        address _troveManager,
        address _priceFeed,
        address _pool,
        address _musd,
        address _btc,
        address _treasury
    ) {
        if (IMezoPool(_pool).stable()) revert BadPool();
        address t0 = IMezoPool(_pool).token0();
        address t1 = IMezoPool(_pool).token1();
        bool m0;
        if (t0 == _musd && t1 == _btc) m0 = true;
        else if (!(t0 == _btc && t1 == _musd)) revert BadPool();

        bos = IBorrowerOperationsSignatures(_bos);
        troveManager = ITroveManager(_troveManager);
        priceFeed = IPriceFeed(_priceFeed);
        pool = IMezoPool(_pool);
        poolFactory = IMezoPoolFactory(IMezoPool(_pool).factory());
        musd = _musd;
        btc = _btc;
        musdIsToken0 = m0;
        owner = msg.sender;
        treasury = _treasury;
    }

    modifier lock(uint8 flow) {
        if (_flow != IDLE) revert Busy();
        _flow = flow;
        _;
        _flow = IDLE;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    /// Collateral released by MUSD arrives here by native call. Accept it only mid-flow.
    receive() external payable {
        if (_flow == IDLE) revert UnexpectedBtc();
    }

    // ---------------------------------------------------------------- coil (open)

    /// @notice Open a leveraged trove in one transaction.
    /// @param totalColl   Collateral of the new trove (deposit after fee + flashed BTC). Signed as `assetAmount`.
    /// @param debtAmount  MUSD the trove mints to this contract. Must cover the pool repayment; the rest is refunded.
    /// @param signature   EIP-712 `OpenTrove(totalColl, debtAmount, borrower=msg.sender, recipient=this, nonce, deadline)`
    ///                    for MUSD's BorrowerOperationsSignatures.
    function coil(
        uint256 totalColl,
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline
    ) external payable lock(OPEN) returns (uint256 musdRefund) {
        uint256 fee = (msg.value * feeBps) / 10_000;
        uint256 deposit = msg.value - fee;
        if (totalColl <= deposit) revert NothingToFlash();
        uint256 flashBtc = totalColl - deposit;

        uint256 musdBefore = IERC20Min(musd).balanceOf(address(this));
        bytes memory inner =
            abi.encode(msg.sender, totalColl, debtAmount, upperHint, lowerHint, deadline, signature);
        _flash(false, flashBtc, abi.encode(OPEN, inner));

        uint256 musdAfter = IERC20Min(musd).balanceOf(address(this));
        musdRefund = musdAfter - musdBefore;
        if (musdRefund > 0) _sendToken(musd, msg.sender, musdRefund);
        if (fee > 0) _sendBtc(treasury, fee);

        emit Coiled(
            msg.sender, deposit, totalColl, debtAmount, flashBtc, debtAmount - musdRefund, musdRefund
        );
    }

    // ---------------------------------------------------------------- unwind (close)

    /// @notice Close the caller's whole trove in one transaction and receive the net BTC.
    /// @param signature EIP-712 `CloseTrove(borrower=msg.sender, recipient=this, nonce, deadline)`.
    function unwind(bytes calldata signature, uint256 deadline, uint256 minBtcOut)
        external
        lock(CLOSE)
        returns (uint256 btcOut)
    {
        uint256 musdOwed = closeAmount(msg.sender);
        uint256 btcBefore = address(this).balance;
        uint256 musdBefore = IERC20Min(musd).balanceOf(address(this));

        _flash(true, musdOwed, abi.encode(CLOSE, abi.encode(msg.sender, deadline, signature)));

        btcOut = address(this).balance - btcBefore;
        if (btcOut < minBtcOut) revert Slippage(btcOut, minBtcOut);
        // The flash is fully burned by MUSD except the rounding buffer, which goes back to the user.
        uint256 musdLeft = IERC20Min(musd).balanceOf(address(this)) - musdBefore;
        if (musdLeft > 0) _sendToken(musd, msg.sender, musdLeft);
        _sendBtc(msg.sender, btcOut);

        emit Unwound(msg.sender, musdOwed - musdLeft, btcOut);
    }

    // ---------------------------------------------------------------- deleverage (partial)

    /// @notice Repay `debtRepay` MUSD and withdraw `collWithdrawal` BTC in one transaction,
    ///         funding the repayment with a flash swap. The BTC left after paying the pool is sent to you.
    /// @param signature EIP-712 `AdjustTrove(collWithdrawal, debtRepay, false, 0, borrower=msg.sender, recipient=this, nonce, deadline)`.
    function deleverage(
        uint256 collWithdrawal,
        uint256 debtRepay,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline,
        uint256 minBtcOut
    ) external lock(DELEVER) returns (uint256 btcOut) {
        btcOut = _delever(msg.sender, collWithdrawal, debtRepay, upperHint, lowerHint, signature, deadline);
        if (btcOut < minBtcOut) revert Slippage(btcOut, minBtcOut);
        _sendBtc(msg.sender, btcOut);
        emit Delevered(msg.sender, collWithdrawal, debtRepay, btcOut);
    }

    // ---------------------------------------------------------------- guard (signed stop-loss)

    /// @notice Store a pre-signed deleverage that anyone may execute once BTC/USD <= `triggerPrice`.
    /// @dev    The signature only authorises one exact adjustment with this contract as recipient.
    ///         Any other trove operation by the user bumps the MUSD nonce and makes it stale.
    function armGuard(
        uint128 triggerPrice,
        uint128 collWithdrawal,
        uint128 debtRepay,
        uint16 bountyBps,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (bountyBps > MAX_BOUNTY_BPS || deadline <= block.timestamp || triggerPrice == 0) revert BadParam();
        if (collWithdrawal == 0 || debtRepay == 0 || signature.length == 0) revert BadParam();
        _guards[msg.sender] = Guard({
            triggerPrice: triggerPrice,
            collWithdrawal: collWithdrawal,
            debtRepay: debtRepay,
            deadline: deadline,
            bountyBps: bountyBps,
            nonce: uint64(bos.getNonce(msg.sender)),
            signature: signature
        });
        emit GuardArmed(msg.sender, triggerPrice, collWithdrawal, debtRepay, bountyBps, deadline);
    }

    function disarmGuard() external {
        delete _guards[msg.sender];
        emit GuardDisarmed(msg.sender);
    }

    /// @notice Execute `user`'s Guard. Pays the caller `bountyBps` of the BTC released.
    function fireGuard(address user, address upperHint, address lowerHint)
        external
        lock(DELEVER)
        returns (uint256 bounty)
    {
        Guard memory g = _guards[user];
        if (g.signature.length == 0) revert NoGuard();
        if (block.timestamp > g.deadline) revert GuardExpired();
        uint256 price = priceFeed.fetchPrice();
        if (price > g.triggerPrice) revert NotTriggered(price, g.triggerPrice);
        delete _guards[user];

        uint256 btcOut =
            _delever(user, g.collWithdrawal, g.debtRepay, upperHint, lowerHint, g.signature, g.deadline);
        bounty = (btcOut * g.bountyBps) / 10_000;
        if (bounty > 0) _sendBtc(msg.sender, bounty);
        _sendBtc(user, btcOut - bounty);

        emit Delevered(user, g.collWithdrawal, g.debtRepay, btcOut);
        emit GuardFired(user, msg.sender, price, btcOut - bounty, bounty);
    }

    // ---------------------------------------------------------------- flash swap callback

    /// @inheritdoc IPoolCallee
    function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external {
        if (msg.sender != address(pool) || sender != address(this) || _flow == IDLE) revert Unauthorized();
        (uint8 op, bytes memory inner) = abi.decode(data, (uint8, bytes));
        if (op != _flow) revert Unauthorized();

        (uint256 rMusd, uint256 rBtc) = _reserves();

        if (op == OPEN) {
            (
                address user,
                uint256 totalColl,
                uint256 debtAmount,
                address upperHint,
                address lowerHint,
                uint256 deadline,
                bytes memory signature
            ) = abi.decode(inner, (address, uint256, uint256, address, address, uint256, bytes));

            // The flashed BTC is already in our balance (ERC-20 precompile == native balance).
            bos.openTroveWithSignature{value: totalColl}(
                debtAmount, upperHint, lowerHint, user, address(this), signature, deadline
            );
            uint256 flashBtc = musdIsToken0 ? amount1 : amount0;
            uint256 musdIn = _amountIn(flashBtc, rMusd, rBtc);
            if (musdIn > debtAmount) revert DebtTooSmall(debtAmount, musdIn);
            _sendToken(musd, address(pool), musdIn);
        } else if (op == CLOSE) {
            (address user, uint256 deadline, bytes memory signature) =
                abi.decode(inner, (address, uint256, bytes));
            bos.closeTroveWithSignature(user, address(this), signature, deadline);
            _repayPoolInBtc(musdIsToken0 ? amount0 : amount1, rMusd, rBtc);
        } else {
            (
                address user,
                uint256 collWithdrawal,
                uint256 debtRepay,
                address upperHint,
                address lowerHint,
                uint256 deadline,
                bytes memory signature
            ) = abi.decode(inner, (address, uint256, uint256, address, address, uint256, bytes));
            bos.adjustTroveWithSignature(
                collWithdrawal, debtRepay, false, upperHint, lowerHint, user, address(this), signature, deadline
            );
            _repayPoolInBtc(musdIsToken0 ? amount0 : amount1, rMusd, rBtc);
        }
    }

    // ---------------------------------------------------------------- views

    /// MUSD the pool wants for `btcOut` BTC (exact-out quote on the volatile curve, fee included).
    function quoteMusdForBtc(uint256 btcOut) external view returns (uint256) {
        (uint256 rMusd, uint256 rBtc) = _reserves();
        return _amountIn(btcOut, rMusd, rBtc);
    }

    /// BTC the pool wants for `musdOut` MUSD.
    function quoteBtcForMusd(uint256 musdOut) external view returns (uint256) {
        (uint256 rMusd, uint256 rBtc) = _reserves();
        return _amountIn(musdOut, rBtc, rMusd);
    }

    /// MUSD that must be flashed to close `user`'s trove (debt minus the 200 MUSD gas compensation).
    function closeAmount(address user) public view returns (uint256) {
        (, uint256 principal, uint256 interest,, uint256 pendingPrincipal, uint256 pendingInterest) =
            troveManager.getEntireDebtAndColl(user);
        uint256 debt = principal + interest + pendingPrincipal + pendingInterest;
        if (debt <= GAS_COMPENSATION) revert NoDebt();
        return debt - GAS_COMPENSATION + CLOSE_BUFFER;
    }

    function guardOf(address user) external view returns (Guard memory) {
        return _guards[user];
    }

    /// @return armed     a Guard is stored for `user`
    /// @return fresh     its signature still matches the user's current MUSD nonce and deadline
    /// @return triggered MUSD's price feed is at or below the trigger right now
    function guardStatus(address user) external view returns (bool armed, bool fresh, bool triggered) {
        Guard storage g = _guards[user];
        armed = g.signature.length != 0;
        if (!armed) return (false, false, false);
        fresh = g.nonce == bos.getNonce(user) && block.timestamp <= g.deadline;
        triggered = priceFeed.fetchPrice() <= g.triggerPrice;
    }

    /// Reserves as (MUSD, BTC) and the pool fee in bps.
    function poolState() external view returns (uint256 reserveMusd, uint256 reserveBtc, uint256 feeBps_) {
        (reserveMusd, reserveBtc) = _reserves();
        feeBps_ = poolFactory.getFee(address(pool), false);
    }

    // ---------------------------------------------------------------- admin

    function setFee(uint16 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert BadParam();
        feeBps = _feeBps;
        emit FeeChanged(_feeBps);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert BadParam();
        treasury = _treasury;
        emit TreasuryChanged(_treasury);
    }

    function setOwner(address _owner) external onlyOwner {
        if (_owner == address(0)) revert BadParam();
        owner = _owner;
        emit OwnerChanged(_owner);
    }

    // ---------------------------------------------------------------- internals

    function _delever(
        address user,
        uint256 collWithdrawal,
        uint256 debtRepay,
        address upperHint,
        address lowerHint,
        bytes memory signature,
        uint256 deadline
    ) internal returns (uint256 btcOut) {
        uint256 btcBefore = address(this).balance;
        bytes memory inner =
            abi.encode(user, collWithdrawal, debtRepay, upperHint, lowerHint, deadline, signature);
        _flash(true, debtRepay, abi.encode(DELEVER, inner));
        btcOut = address(this).balance - btcBefore;
    }

    /// Flash-swap `amount` of MUSD (`outMusd`) or BTC out of the pool to this contract.
    function _flash(bool outMusd, uint256 amount, bytes memory data) internal {
        bool out0 = outMusd == musdIsToken0;
        pool.swap(out0 ? amount : 0, out0 ? 0 : amount, address(this), data);
    }

    function _repayPoolInBtc(uint256 musdOut, uint256 rMusd, uint256 rBtc) internal {
        uint256 btcIn = _amountIn(musdOut, rBtc, rMusd);
        uint256 available = address(this).balance;
        if (btcIn > available) revert CollateralShort(available, btcIn);
        _sendToken(btc, address(pool), btcIn);
    }

    /// Exact-out input for the volatile (x*y) curve after the pool fee:
    /// (rIn + in*(1-fee)) * (rOut - out) >= rIn * rOut.
    function _amountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        internal
        view
        returns (uint256)
    {
        if (amountOut >= reserveOut) revert InsufficientLiquidity();
        uint256 fee = poolFactory.getFee(address(pool), false);
        return (reserveIn * amountOut * 10_000) / ((reserveOut - amountOut) * (10_000 - fee)) + 1;
    }

    function _reserves() internal view returns (uint256 rMusd, uint256 rBtc) {
        (uint256 r0, uint256 r1,) = pool.getReserves();
        (rMusd, rBtc) = musdIsToken0 ? (r0, r1) : (r1, r0);
    }

    function _sendToken(address token, address to, uint256 amount) internal {
        if (!IERC20Min(token).transfer(to, amount)) revert TransferFailed();
    }

    function _sendBtc(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
