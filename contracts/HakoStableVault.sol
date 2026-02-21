// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";

import "./stable/HakoStableVaultStorage.sol";
import "./stable/HakoStableVaultTypes.sol";
import "./stable/HakoStableVaultRegistry.sol";
import "./shared/VaultMath.sol";

/// @title Hako Stable Vault
/// @notice Home vault that tracks local + remote deposits and withdrawal requests.
/// @dev This contract is UUPS-upgradeable and uses role-based controls via AccessControl.
contract HakoStableVault is
    Initializable,
    ERC20Upgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    HakoStableVaultRegistry
{
    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant WITHDRAW_FINALIZER_ROLE = keccak256("WITHDRAW_FINALIZER_ROLE");
    bytes32 public constant ASSET_MANAGER_ROLE = keccak256("ASSET_MANAGER_ROLE");
    bytes32 public constant CONFIG_MANAGER_ROLE = keccak256("CONFIG_MANAGER_ROLE");

    uint256 internal constant DEFAULT_MIN_DEPOSIT = 1e15;
    uint256 internal constant MAX_PERFORMANCE_FEE = 3000;

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    /// @dev Locks implementation contract to prevent direct initialization.
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes vault metadata, roles, and initial allowed deposit tokens.
    /// @param name Vault LP token name.
    /// @param symbol Vault LP token symbol.
    /// @param initialOwner Initial admin/operator address.
    /// @param allowedDepositTokens List of allowed local deposit assets.
    function initialize(
        string calldata name,
        string calldata symbol,
        address initialOwner,
        address[] calldata allowedDepositTokens
    ) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();

        __ERC20_init(name, symbol);
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(UPGRADER_ROLE, initialOwner);
        _grantRole(GUARDIAN_ROLE, initialOwner);
        _grantRole(RELAYER_ROLE, initialOwner);
        _grantRole(WITHDRAW_FINALIZER_ROLE, initialOwner);
        _grantRole(ASSET_MANAGER_ROLE, initialOwner);
        _grantRole(CONFIG_MANAGER_ROLE, initialOwner);

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        layout_.highWaterMark = VaultMath.PRECISION;
        layout_.minDepositNormalized = DEFAULT_MIN_DEPOSIT;

        emit HighWaterMarkUpdated(VaultMath.PRECISION);
        emit MinDepositUpdated(0, DEFAULT_MIN_DEPOSIT);

        for (uint256 i = 0; i < allowedDepositTokens.length; i++) {
            _addAllowedDepositToken(allowedDepositTokens[i]);
        }
    }

    // -------------------------------------------------------------------------
    // Pause Controls
    // -------------------------------------------------------------------------

    /// @notice Pauses user/operator flows guarded by `whenNotPaused`.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Unpauses vault flows after incident resolution.
    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    /// @notice Adds a token that can be deposited locally.
    /// @param token ERC20 token address.
    function addAllowedDepositToken(address token) external onlyRole(CONFIG_MANAGER_ROLE) {
        _addAllowedDepositToken(token);
    }

    /// @notice Removes a token from the local deposit allowlist.
    /// @param token ERC20 token address.
    function removeAllowedDepositToken(address token) external onlyRole(CONFIG_MANAGER_ROLE) {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (!layout_.allowedDepositToken[token]) return;

        layout_.allowedDepositToken[token] = false;
        emit AllowedDepositTokenUpdated(token, layout_.depositTokenDecimals[token], false);
    }

    /// @notice Enables or disables a destination chain for withdrawals.
    /// @param dstChainId Destination chain identifier.
    /// @param allowed Whether the chain is allowed.
    function setDestinationChainAllowed(uint64 dstChainId, bool allowed) external onlyRole(CONFIG_MANAGER_ROLE) {
        HakoStableVaultStorage.layout().allowedDestinationChain[dstChainId] = allowed;
        emit DestinationChainUpdated(dstChainId, allowed);
    }

    /// @notice Sets destination token allowlist state for a chain.
    /// @param dstChainId Destination chain identifier.
    /// @param token Destination token address (or virtual token).
    /// @param allowed Whether the destination token is allowed.
    function setDestinationAssetAllowed(
        uint64 dstChainId,
        address token,
        bool allowed
    ) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (token == address(0)) revert ZeroAddress();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (!layout_.allowedDestinationChain[dstChainId]) revert DestinationChainNotAllowed(dstChainId);

        layout_.allowedDestinationToken[dstChainId][token] = allowed;
        emit DestinationAssetUpdated(dstChainId, token, allowed);
    }

    /// @notice Enables or disables an external ERC-4626 vault for allocation deposits.
    /// @param vault External ERC-4626 vault address.
    /// @param allowed Whether the vault is allowed.
    function setExternalVaultAllowed(address vault, bool allowed) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (vault == address(0)) revert ZeroAddress();

        HakoStableVaultStorage.layout().allowedExternalVault[vault] = allowed;
        emit ExternalVaultAllowlistUpdated(vault, allowed);
    }

    /// @notice Sets performance fee in basis points.
    /// @param feeBps Fee in bps. Max value is `MAX_PERFORMANCE_FEE`.
    function setPerformanceFee(uint256 feeBps) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (feeBps > MAX_PERFORMANCE_FEE) revert FeeTooHigh();
        HakoStableVaultStorage.layout().performanceFeeBps = feeBps;
        emit PerformanceFeeUpdated(feeBps);
    }

    /// @notice Sets recipient for newly minted performance fee shares.
    /// @param recipient Recipient address.
    function setFeeRecipient(address recipient) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        HakoStableVaultStorage.layout().feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    /// @notice Updates the normalized minimum deposit amount (18 decimals).
    /// @param minDepositValue Minimum allowed deposit value in normalized units.
    function setMinDeposit(uint256 minDepositValue) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (minDepositValue == 0) revert AmountZero();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        uint256 oldMinDeposit = layout_.minDepositNormalized;
        layout_.minDepositNormalized = minDepositValue;
        emit MinDepositUpdated(oldMinDeposit, minDepositValue);
    }

    // -------------------------------------------------------------------------
    // Deposit Flows
    // -------------------------------------------------------------------------

    /// @notice Deposits a local EVM token and mints vault LP shares.
    /// @param token Deposit token address (must be allowlisted).
    /// @param amount Raw token amount in token decimals.
    /// @param receiver Receiver of minted LP shares.
    /// @return sharesMinted Amount of LP shares minted.
    function deposit(address token, uint256 amount, address receiver)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 sharesMinted)
    {
        if (token == address(0) || receiver == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountZero();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (!layout_.allowedDepositToken[token]) revert TokenNotAllowed(token);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        uint256 amountNormalized = VaultMath.normalizeAmount(amount, layout_.depositTokenDecimals[token]);
        if (amountNormalized < layout_.minDepositNormalized) revert BelowMinDeposit();

        sharesMinted = _mintSharesForDeposit(receiver, amountNormalized);

        bytes32 depositId = keccak256(abi.encodePacked(block.chainid, address(this), ++layout_.nextDepositId));
        emit DepositRecorded(depositId, receiver, amountNormalized, sharesMinted, false);
    }

    /// @notice Records a remote-chain deposit for an EVM receiver and mints LP shares.
    /// @param depositId Unique cross-chain deposit id for replay protection.
    /// @param receiver Receiver of minted LP shares.
    /// @param amountNormalized Deposit value in normalized 18-decimal units.
    /// @return sharesMinted Amount of LP shares minted.
    function recordRemoteDeposit(bytes32 depositId, address receiver, uint256 amountNormalized)
        external
        onlyRole(RELAYER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 sharesMinted)
    {
        if (receiver == address(0)) revert ZeroAddress();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (layout_.processedDeposits[depositId]) revert DepositAlreadyProcessed(depositId);
        layout_.processedDeposits[depositId] = true;

        sharesMinted = _mintSharesForDeposit(receiver, amountNormalized);
        emit DepositRecorded(depositId, receiver, amountNormalized, sharesMinted, true);
    }

    /// @notice Records a remote-chain deposit for a non-EVM account and mints LP shares to its pseudo address.
    /// @param depositId Unique cross-chain deposit id for replay protection.
    /// @param receiverChainId Source chain id of the non-EVM receiver.
    /// @param receiver Non-EVM receiver identifier.
    /// @param amountNormalized Deposit value in normalized 18-decimal units.
    /// @return sharesMinted Amount of LP shares minted.
    function recordRemoteDepositNonEvm(
        bytes32 depositId,
        uint64 receiverChainId,
        string calldata receiver,
        uint256 amountNormalized
    )
        external
        onlyRole(RELAYER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 sharesMinted)
    {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (layout_.processedDeposits[depositId]) revert DepositAlreadyProcessed(depositId);

        address pseudoReceiver = _registerNonEvmAccount(receiverChainId, receiver);
        layout_.processedDeposits[depositId] = true;

        sharesMinted = _mintSharesForDeposit(pseudoReceiver, amountNormalized);

        emit DepositRecorded(depositId, pseudoReceiver, amountNormalized, sharesMinted, true);
        emit NonEvmDepositRecorded(depositId, receiverChainId, receiver, pseudoReceiver, amountNormalized, sharesMinted);
    }

    // -------------------------------------------------------------------------
    // Withdrawal Request Flows
    // -------------------------------------------------------------------------

    /// @notice Creates a withdrawal request by target amount and locks corresponding shares.
    /// @param receiver Destination EVM receiver address.
    /// @param dstChainId Destination chain id.
    /// @param token Destination token address.
    /// @param amountNormalized Requested normalized withdrawal amount.
    /// @param maxShares Maximum shares caller allows to lock.
    /// @return requestId Created withdrawal request id.
    function requestWithdrawal(
        address receiver,
        uint64 dstChainId,
        address token,
        uint256 amountNormalized,
        uint256 maxShares
    ) external nonReentrant whenNotPaused returns (uint256 requestId) {
        if (receiver == address(0)) revert ZeroAddress();
        if (amountNormalized == 0) revert AmountZero();

        bytes memory receiverData = abi.encodePacked(receiver);
        _validateDestination(dstChainId, token);
        requestId = _createWithdrawalRequest(msg.sender, receiverData, dstChainId, token, amountNormalized, maxShares);
    }

    /// @notice Creates a withdrawal request by fixed share amount and locks exactly those shares.
    /// @param receiver Destination EVM receiver address.
    /// @param dstChainId Destination chain id.
    /// @param token Destination token address.
    /// @param shares Shares to redeem.
    /// @param minAmountNormalized Minimum normalized assets expected.
    /// @return requestId Created withdrawal request id.
    function requestRedeem(
        address receiver,
        uint64 dstChainId,
        address token,
        uint256 shares,
        uint256 minAmountNormalized
    ) external nonReentrant whenNotPaused returns (uint256 requestId) {
        if (receiver == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroShares();

        bytes memory receiverData = abi.encodePacked(receiver);
        _validateDestination(dstChainId, token);
        requestId =
            _createWithdrawalRequestFromShares(msg.sender, receiverData, dstChainId, token, shares, minAmountNormalized);
    }

    /// @notice Controller/relayer-created withdrawal request for an owner with nonce protection.
    /// @param owner Share owner.
    /// @param receiver Raw destination receiver bytes.
    /// @param dstChainId Destination chain id.
    /// @param token Destination token address.
    /// @param amountNormalized Requested normalized withdrawal amount.
    /// @param maxShares Maximum shares allowed to lock.
    /// @param expectedNonce Expected owner withdrawal nonce.
    /// @return requestId Created withdrawal request id.
    function requestWithdrawalController(
        address owner,
        bytes calldata receiver,
        uint64 dstChainId,
        address token,
        uint256 amountNormalized,
        uint256 maxShares,
        uint256 expectedNonce
    ) external onlyRole(RELAYER_ROLE) nonReentrant whenNotPaused returns (uint256 requestId) {
        if (owner == address(0)) revert ZeroAddress();
        if (receiver.length == 0) revert InvalidReceiverData();
        if (amountNormalized == 0) revert AmountZero();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        uint256 nonce = layout_.withdrawalNonces[owner];
        if (nonce != expectedNonce) revert InvalidWithdrawalNonce(expectedNonce, nonce);
        layout_.withdrawalNonces[owner] = nonce + 1;

        _validateDestination(dstChainId, token);
        requestId = _createWithdrawalRequest(owner, receiver, dstChainId, token, amountNormalized, maxShares);
    }

    /// @notice Records a remote withdrawal request and creates local locked-share request.
    /// @param remoteRequestId Unique remote request id for replay protection.
    /// @param owner Share owner.
    /// @param receiver Raw destination receiver bytes.
    /// @param dstChainId Destination chain id.
    /// @param token Destination token address.
    /// @param amountNormalized Requested normalized withdrawal amount.
    /// @param maxShares Maximum shares allowed to lock.
    /// @return requestId Created withdrawal request id.
    function recordRemoteWithdrawalRequest(
        bytes32 remoteRequestId,
        address owner,
        bytes calldata receiver,
        uint64 dstChainId,
        address token,
        uint256 amountNormalized,
        uint256 maxShares
    ) external onlyRole(RELAYER_ROLE) nonReentrant whenNotPaused returns (uint256 requestId) {
        if (owner == address(0)) revert ZeroAddress();
        if (receiver.length == 0) revert InvalidReceiverData();
        if (amountNormalized == 0) revert AmountZero();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (layout_.processedRemoteWithdrawalRequests[remoteRequestId]) {
            revert RemoteWithdrawalAlreadyProcessed(remoteRequestId);
        }
        layout_.processedRemoteWithdrawalRequests[remoteRequestId] = true;

        _validateDestination(dstChainId, token);
        requestId = _createWithdrawalRequest(owner, receiver, dstChainId, token, amountNormalized, maxShares);

        WithdrawalRequest storage req = layout_.withdrawalRequests[requestId];
        emit RemoteWithdrawalRequestRecorded(
            remoteRequestId,
            requestId,
            req.owner,
            req.dstChainId,
            req.token,
            layout_.withdrawalReceiverData[requestId],
            req.amountNormalized,
            req.sharesLocked
        );
    }

    /// @notice Finalizes a pending withdrawal request and burns locked shares.
    /// @param requestId Withdrawal request id.
    function completeWithdrawal(uint256 requestId) external onlyRole(WITHDRAW_FINALIZER_ROLE) nonReentrant {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        WithdrawalRequest storage req = layout_.withdrawalRequests[requestId];
        if (req.status != WithdrawalStatus.Pending) revert WithdrawalNotPending(requestId);

        req.status = WithdrawalStatus.Completed;

        layout_.lockedShares[req.owner] -= req.sharesLocked;
        if (layout_.totalManagedAssets < req.amountNormalized) revert ManagedAssetsUnderflow();
        layout_.totalManagedAssets -= req.amountNormalized;

        _burn(req.owner, req.sharesLocked);

        emit WithdrawalCompleted(requestId, req.owner, req.sharesLocked, req.amountNormalized);
    }

    /// @notice Cancels a pending withdrawal request and unlocks shares.
    /// @param requestId Withdrawal request id.
    function cancelWithdrawal(uint256 requestId) external onlyRole(WITHDRAW_FINALIZER_ROLE) nonReentrant {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        WithdrawalRequest storage req = layout_.withdrawalRequests[requestId];
        if (req.status != WithdrawalStatus.Pending) revert WithdrawalNotPending(requestId);

        req.status = WithdrawalStatus.Canceled;
        layout_.lockedShares[req.owner] -= req.sharesLocked;

        emit WithdrawalCanceled(requestId, req.owner, req.sharesLocked);
    }

    // -------------------------------------------------------------------------
    // Asset Management
    // -------------------------------------------------------------------------

    /// @notice Transfers allowlisted stable assets out for bridge/swap operations (for example Near intents).
    /// @dev Applies operation-id replay protection; does not change managed-assets accounting on home vault.
    /// @param operationId Unique operation id for replay protection.
    /// @param token Token to transfer.
    /// @param to Destination address.
    /// @param amountToken Amount in token decimals.
    /// @param reasonCode Optional reason code for offchain indexing.
    function transferOut(bytes32 operationId, address token, address to, uint256 amountToken, bytes32 reasonCode)
        external
        onlyRole(ASSET_MANAGER_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amountToken == 0) revert AmountZero();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (layout_.processedTransferOut[operationId]) revert OperationAlreadyProcessed(operationId);
        if (!layout_.allowedDepositToken[token]) revert TokenNotAllowed(token);

        uint256 amountNormalized = VaultMath.normalizeAmount(amountToken, layout_.depositTokenDecimals[token]);

        layout_.processedTransferOut[operationId] = true;

        IERC20(token).safeTransfer(to, amountToken);
        emit TransferOut(operationId, token, to, amountToken, amountNormalized, reasonCode);
    }

    /// @notice Adjusts total managed assets by reported strategy PnL.
    /// @param deltaNormalized Signed normalized delta (positive for profit, negative for loss).
    function adjustManagedAssets(int256 deltaNormalized) external onlyRole(ASSET_MANAGER_ROLE) nonReentrant whenNotPaused {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();

        if (deltaNormalized > 0) {
            uint256 profit = uint256(deltaNormalized);
            layout_.totalManagedAssets += profit;
            _collectPerformanceFee(profit);
        } else if (deltaNormalized < 0) {
            if (deltaNormalized == type(int256).min) revert ManagedAssetsUnderflow();
            uint256 absDelta = uint256(-deltaNormalized);
            if (layout_.totalManagedAssets < absDelta) revert ManagedAssetsUnderflow();
            layout_.totalManagedAssets -= absDelta;
        }

        emit ManagedAssetsAdjusted(deltaNormalized, layout_.totalManagedAssets);
    }

    /// @notice Deposits an underlying token amount into an allowlisted external ERC-4626 vault.
    /// @param vault External ERC-4626 vault address.
    /// @param assets Underlying asset amount in vault asset decimals.
    /// @return sharesMinted External vault shares received.
    function depositIntoExternalVault(address vault, uint256 assets)
        external
        onlyRole(ASSET_MANAGER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 sharesMinted)
    {
        if (assets == 0) revert AmountZero();

        address asset = _cacheExternalVault(vault);

        IERC20 underlying = IERC20(asset);
        uint256 allowance = underlying.allowance(address(this), vault);
        if (allowance < assets) {
            underlying.forceApprove(vault, type(uint256).max);
        }

        sharesMinted = IERC4626(vault).deposit(assets, address(this));
        emit ExternalVaultDeposit(vault, asset, assets, sharesMinted);
    }

    /// @notice Withdraws underlying assets from an external ERC-4626 vault.
    /// @param vault External ERC-4626 vault address.
    /// @param assets Underlying asset amount to withdraw.
    /// @param receiver Receiver address (`0` means this contract).
    /// @return sharesBurned External vault shares burned.
    function withdrawFromExternalVault(address vault, uint256 assets, address receiver)
        external
        onlyRole(ASSET_MANAGER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 sharesBurned)
    {
        if (assets == 0) revert AmountZero();
        if (receiver != address(0) && receiver != address(this)) revert ExternalReceiverNotAllowed();

        address asset = _getExternalVaultInfo(vault);
        address to = receiver == address(0) ? address(this) : receiver;
        sharesBurned = IERC4626(vault).withdraw(assets, to, address(this));
        emit ExternalVaultWithdraw(vault, asset, assets, sharesBurned, to);
    }

    /// @notice Redeems external vault shares for underlying assets.
    /// @param vault External ERC-4626 vault address.
    /// @param shares External vault shares to redeem.
    /// @param receiver Receiver address (`0` means this contract).
    /// @return assetsReceived Underlying assets received.
    function redeemFromExternalVault(address vault, uint256 shares, address receiver)
        external
        onlyRole(ASSET_MANAGER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 assetsReceived)
    {
        if (shares == 0) revert AmountZero();
        if (receiver != address(0) && receiver != address(this)) revert ExternalReceiverNotAllowed();

        address asset = _getExternalVaultInfo(vault);
        address to = receiver == address(0) ? address(this) : receiver;
        assetsReceived = IERC4626(vault).redeem(shares, to, address(this));
        emit ExternalVaultRedeem(vault, asset, shares, assetsReceived, to);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns vault-managed assets in normalized units.
    function totalAssets() external view returns (uint256) {
        return HakoStableVaultStorage.layout().totalManagedAssets;
    }

    /// @notice Returns performance fee in basis points.
    function performanceFeeBps() external view returns (uint256) {
        return HakoStableVaultStorage.layout().performanceFeeBps;
    }

    /// @notice Returns current performance fee recipient.
    function feeRecipient() external view returns (address) {
        return HakoStableVaultStorage.layout().feeRecipient;
    }

    /// @notice Returns current high-water-mark share price (1e18 precision).
    function highWaterMark() external view returns (uint256) {
        return HakoStableVaultStorage.layout().highWaterMark;
    }

    /// @notice Returns current minimum normalized deposit amount.
    function minDepositNormalized() external view returns (uint256) {
        return HakoStableVaultStorage.layout().minDepositNormalized;
    }

    /// @notice Returns currently locked shares for an owner.
    /// @param owner Share owner.
    function lockedShares(address owner) external view returns (uint256) {
        return HakoStableVaultStorage.layout().lockedShares[owner];
    }

    /// @notice Returns current withdrawal nonce for an owner.
    /// @param owner Share owner.
    function withdrawalNonce(address owner) external view returns (uint256) {
        return HakoStableVaultStorage.layout().withdrawalNonces[owner];
    }

    /// @notice Returns stored withdrawal request metadata.
    /// @param requestId Request id.
    function getWithdrawalRequest(uint256 requestId)
        external
        view
        returns (
            address owner,
            address receiver,
            uint64 dstChainId,
            address token,
            uint256 amountNormalized,
            uint256 sharesLocked,
            WithdrawalStatus status
        )
    {
        WithdrawalRequest storage req = HakoStableVaultStorage.layout().withdrawalRequests[requestId];
        return (
            req.owner,
            req.receiver,
            req.dstChainId,
            req.token,
            req.amountNormalized,
            req.sharesLocked,
            req.status
        );
    }

    /// @notice Returns raw receiver bytes for a withdrawal request.
    /// @param requestId Request id.
    function getWithdrawalReceiver(uint256 requestId) external view returns (bytes memory) {
        return HakoStableVaultStorage.layout().withdrawalReceiverData[requestId];
    }

    /// @notice Returns current non-zero external vault positions and normalized valuation.
    function getExternalVaultPositions() external view returns (ExternalVaultPositionView[] memory positions) {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();

        uint256 len = layout_.externalVaultsList.length;
        uint256 count;

        for (uint256 i = 0; i < len; i++) {
            address vault = layout_.externalVaultsList[i];
            address asset = layout_.externalVaultAsset[vault];
            if (asset == address(0)) continue;
            uint256 shareBalance = IERC20(vault).balanceOf(address(this));
            if (shareBalance == 0) continue;
            count++;
        }

        positions = new ExternalVaultPositionView[](count);

        uint256 posIndex;
        for (uint256 i = 0; i < len; i++) {
            address vault = layout_.externalVaultsList[i];
            address asset = layout_.externalVaultAsset[vault];
            if (asset == address(0)) continue;

            uint256 shareBalance = IERC20(vault).balanceOf(address(this));
            if (shareBalance == 0) continue;

            uint256 assetsValue = IERC4626(vault).convertToAssets(shareBalance);
            positions[posIndex] = ExternalVaultPositionView({
                vault: vault,
                asset: asset,
                shareBalance: shareBalance,
                assets: assetsValue,
                assetsNormalized: VaultMath.normalizeAmount(assetsValue, layout_.depositTokenDecimals[asset])
            });
            posIndex++;
        }
    }

    /// @notice Deterministically derives a virtual destination token address for non-EVM settlement.
    /// @dev Uses the same derivation path as vault internals (`hako:token:{chainId}:{tokenId}` with zero-address fallback).
    /// @param dstChainId Destination chain identifier.
    /// @param tokenId Destination token identifier on that chain.
    /// @return virtualToken Derived virtual token address.
    /// @return tokenHash Hash used to derive the virtual token address.
    function deriveVirtualDestinationTokenAddress(uint64 dstChainId, string calldata tokenId)
        external
        pure
        returns (address virtualToken, bytes32 tokenHash)
    {
        (tokenHash, virtualToken) = _computeVirtualTokenAddress(dstChainId, tokenId);
    }

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    /// @dev Mints shares for a normalized deposit amount and updates managed assets.
    function _mintSharesForDeposit(address receiver, uint256 amountNormalized) internal returns (uint256 sharesMinted) {
        if (receiver == address(0)) revert ZeroAddress();
        if (amountNormalized == 0) revert AmountZero();
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (amountNormalized < layout_.minDepositNormalized) revert BelowMinDeposit();

        uint256 supply = totalSupply();
        uint256 managed = layout_.totalManagedAssets;

        sharesMinted = VaultMath.previewMintShares(amountNormalized, supply, managed);
        if (sharesMinted == 0) revert ZeroShares();

        layout_.totalManagedAssets = managed + amountNormalized;
        _mint(receiver, sharesMinted);
    }

    /// @dev Creates a withdrawal request by normalized amount and locks estimated shares.
    function _createWithdrawalRequest(
        address owner,
        bytes memory receiver,
        uint64 dstChainId,
        address token,
        uint256 amountNormalized,
        uint256 maxShares
    ) internal returns (uint256 requestId) {
        if (owner == address(0)) revert ZeroAddress();
        if (receiver.length == 0) revert InvalidReceiverData();
        if (amountNormalized == 0) revert AmountZero();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();

        uint256 supply = totalSupply();
        uint256 managed = layout_.totalManagedAssets;
        if (managed == 0 || supply == 0) revert VaultEmpty();

        uint256 sharesToLock = VaultMath.previewLockShares(amountNormalized, supply, managed);
        if (sharesToLock == 0) revert ZeroShares();
        if (sharesToLock > maxShares) revert SharesExceedMax();

        uint256 ownerLocked = layout_.lockedShares[owner];
        if (ownerLocked + sharesToLock > balanceOf(owner)) revert InsufficientUnlockedShares();

        layout_.lockedShares[owner] = ownerLocked + sharesToLock;
        requestId = _storeWithdrawalRequest(layout_, owner, receiver, dstChainId, token, amountNormalized, sharesToLock);
    }

    /// @dev Creates a withdrawal request by exact share amount and computes corresponding assets.
    function _createWithdrawalRequestFromShares(
        address owner,
        bytes memory receiver,
        uint64 dstChainId,
        address token,
        uint256 shares,
        uint256 minAmountNormalized
    ) internal returns (uint256 requestId) {
        if (owner == address(0)) revert ZeroAddress();
        if (receiver.length == 0) revert InvalidReceiverData();
        if (shares == 0) revert ZeroShares();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        uint256 managed = layout_.totalManagedAssets;
        uint256 supply = totalSupply();
        if (managed == 0 || supply == 0) revert VaultEmpty();

        uint256 amountNormalized = VaultMath.convertToAssetsFloor(shares, supply, managed);
        if (amountNormalized == 0) revert AmountZero();
        if (amountNormalized < minAmountNormalized) {
            revert RedeemAmountBelowMinimum(amountNormalized, minAmountNormalized);
        }

        uint256 ownerLocked = layout_.lockedShares[owner];
        if (ownerLocked + shares > balanceOf(owner)) revert InsufficientUnlockedShares();
        layout_.lockedShares[owner] = ownerLocked + shares;
        requestId = _storeWithdrawalRequest(layout_, owner, receiver, dstChainId, token, amountNormalized, shares);
    }

    /// @dev Persists a withdrawal request and emits bytes-based receiver event.
    function _storeWithdrawalRequest(
        HakoStableVaultStorage.Layout storage layout_,
        address owner,
        bytes memory receiver,
        uint64 dstChainId,
        address token,
        uint256 amountNormalized,
        uint256 sharesLocked
    ) internal returns (uint256 requestId) {
        address receiverAddress = _bytesToAddress(receiver);
        requestId = ++layout_.nextWithdrawalId;

        layout_.withdrawalRequests[requestId] = WithdrawalRequest({
            owner: owner,
            receiver: receiverAddress,
            dstChainId: dstChainId,
            token: token,
            amountNormalized: amountNormalized,
            sharesLocked: sharesLocked,
            status: WithdrawalStatus.Pending
        });

        layout_.withdrawalReceiverData[requestId] = receiver;

        emit WithdrawalRequested(requestId, owner, dstChainId, token, receiver, amountNormalized, sharesLocked);
    }

    /// @dev Mints fee shares according to high-water-mark performance fee logic.
    function _collectPerformanceFee(uint256 profit) internal {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();

        if (layout_.performanceFeeBps == 0 || layout_.feeRecipient == address(0) || profit == 0) return;

        uint256 supply = totalSupply();
        uint256 managed = layout_.totalManagedAssets;
        if (supply == 0 || managed == 0) return;

        (uint256 feeShares, uint256 newHwm, uint256 taxableProfit) = VaultMath.calculatePerformanceFeeShares(
            profit,
            layout_.performanceFeeBps,
            managed,
            supply,
            layout_.highWaterMark
        );

        if (newHwm != layout_.highWaterMark) {
            layout_.highWaterMark = newHwm;
            emit HighWaterMarkUpdated(newHwm);
        }

        if (feeShares > 0) {
            _mint(layout_.feeRecipient, feeShares);
            emit PerformanceFeeCollected(taxableProfit, feeShares, layout_.feeRecipient);
        }
    }

    /// @dev Adds a local deposit token after decimals validation.
    function _addAllowedDepositToken(address token) internal {
        if (token == address(0)) revert ZeroAddress();

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (layout_.allowedDepositToken[token]) return;

        uint8 decimals = ERC20(token).decimals();
        if (decimals > 18) revert DecimalsTooHigh();

        layout_.allowedDepositToken[token] = true;
        layout_.depositTokenDecimals[token] = decimals;

        emit AllowedDepositTokenUpdated(token, decimals, true);
    }

    /// @dev Caches external vault asset metadata on first use.
    function _cacheExternalVault(address vault) internal returns (address asset) {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        if (!layout_.allowedExternalVault[vault]) revert ExternalVaultNotAllowed(vault);

        address liveAsset = IERC4626(vault).asset();
        if (liveAsset == address(0)) revert ZeroAddress();

        asset = layout_.externalVaultAsset[vault];
        if (asset == address(0)) {
            if (!layout_.allowedDepositToken[liveAsset]) revert TokenNotAllowed(liveAsset);
            asset = liveAsset;

            layout_.externalVaultAsset[vault] = asset;
            layout_.externalVaultsList.push(vault);

            emit ExternalVaultCached(vault, asset, layout_.depositTokenDecimals[asset]);
            return asset;
        }

        if (asset != liveAsset) revert ExternalVaultAssetMismatch(vault, asset, liveAsset);
    }

    /// @dev ERC20 transfer hook override that enforces non-transferability of locked shares.
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && amount > 0) {
            HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
            uint256 locked = layout_.lockedShares[from];
            if (locked > 0) {
                uint256 balance = super.balanceOf(from);
                if (balance < locked + amount) revert InsufficientUnlockedShares();
            }
        }

        super._update(from, to, amount);
    }

    /// @dev UUPS authorization hook.
    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    /// @dev Validates destination chain and destination token allowlists.
    function _validateDestination(uint64 dstChainId, address token) internal view {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();

        if (!layout_.allowedDestinationChain[dstChainId]) revert DestinationChainNotAllowed(dstChainId);
        if (!layout_.allowedDestinationToken[dstChainId][token]) {
            revert DestinationTokenNotAllowed(dstChainId, token);
        }
    }

    /// @dev Returns cached external vault metadata or reverts if vault is unknown.
    function _getExternalVaultInfo(address vault) internal view returns (address asset) {
        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();

        asset = layout_.externalVaultAsset[vault];
        if (asset == address(0)) revert ExternalVaultUnknown(vault);

        address liveAsset = IERC4626(vault).asset();
        if (liveAsset == address(0)) revert ZeroAddress();
        if (asset != liveAsset) revert ExternalVaultAssetMismatch(vault, asset, liveAsset);
    }
}
