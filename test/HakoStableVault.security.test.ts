import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { keccak256, parseUnits, type Hex } from "viem";
import { deployFixture } from "./fixtures.js";
import { ZERO_ADDRESS, type VaultTestCtx, approveAndDeposit, getEventArgs } from "./hakoStableVaultTestUtils.js";

type TransferOutArgs = {
  operationId: Hex;
  token: `0x${string}`;
  to: `0x${string}`;
  amountToken: bigint;
  amountNormalized: bigint;
  reasonCode: Hex;
};

describe("HakoStableVault roles and security", () => {
  let ctx: VaultTestCtx;

  beforeEach(async () => {
    ctx = await deployFixture();
  });

  async function seedDeposit(usdcAmount: string = "1000") {
    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits(usdcAmount, 6),
      receiver: ctx.user.account.address,
    });
  }

  it("assigns all critical roles to initial owner only", async () => {
    const roleNames = [
      "DEFAULT_ADMIN_ROLE",
      "UPGRADER_ROLE",
      "GUARDIAN_ROLE",
      "RELAYER_ROLE",
      "WITHDRAW_FINALIZER_ROLE",
      "ASSET_MANAGER_ROLE",
      "CONFIG_MANAGER_ROLE",
    ] as const;

    for (const roleName of roleNames) {
      const role = await ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: roleName,
        args: [],
      });

      const [ownerHasRole, userHasRole] = await Promise.all([
        ctx.publicClient.readContract({
          address: ctx.stableVault.address,
          abi: ctx.stableVault.abi,
          functionName: "hasRole",
          args: [role, ctx.owner.account.address],
        }),
        ctx.publicClient.readContract({
          address: ctx.stableVault.address,
          abi: ctx.stableVault.abi,
          functionName: "hasRole",
          args: [role, ctx.user.account.address],
        }),
      ]);

      assert.equal(ownerHasRole, true);
      assert.equal(userHasRole, false);
    }
  });

  it("default admin can grant and revoke relayer role", async () => {
    const relayerRole = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "RELAYER_ROLE",
      args: [],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "grantRole",
      args: [relayerRole, ctx.user.account.address],
    });

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [keccak256("0x1111"), ctx.user.account.address, parseUnits("10", 18)],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "revokeRole",
      args: [relayerRole, ctx.user.account.address],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDeposit",
        args: [keccak256("0x2222"), ctx.user.account.address, parseUnits("10", 18)],
      }),
      /AccessControl/,
    );
  });

  it("non-admin cannot grant roles", async () => {
    const relayerRole = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "RELAYER_ROLE",
      args: [],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "grantRole",
        args: [relayerRole, ctx.user.account.address],
      }),
      /AccessControl/,
    );
  });

  it("guardian pause blocks sensitive flows and unpause re-enables them", async () => {
    await seedDeposit("100");

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "pause",
      args: [],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.usdc.address,
        abi: ctx.usdc.abi,
        functionName: "approve",
        args: [ctx.stableVault.address, parseUnits("10", 6)],
      }).then(() =>
        ctx.user.writeContract({
          address: ctx.stableVault.address,
          abi: ctx.stableVault.abi,
          functionName: "deposit",
          args: [ctx.usdc.address, parseUnits("10", 6), ctx.user.account.address],
        }),
      ),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDeposit",
        args: [keccak256("0xaaaa"), ctx.user.account.address, parseUnits("10", 18)],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestWithdrawal",
        args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("10", 18), parseUnits("10", 18)],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestWithdrawalController",
        args: [
          ctx.user.account.address,
          ctx.user.account.address as Hex,
          8453n,
          ctx.usdc.address,
          parseUnits("10", 18),
          parseUnits("10", 18),
          0n,
        ],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteWithdrawalRequest",
        args: [
          keccak256("0xbbbb"),
          ctx.user.account.address,
          ctx.user.account.address as Hex,
          8453n,
          ctx.usdc.address,
          parseUnits("10", 18),
          parseUnits("10", 18),
        ],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "adjustManagedAssets",
        args: [parseUnits("1", 18)],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transferOut",
        args: [keccak256("0x74"), ctx.usdc.address, ctx.owner.account.address, parseUnits("1", 6), keccak256("0x01")],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "unpause",
      args: [],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [keccak256("0xcccc"), ctx.user.account.address, parseUnits("1", 18)],
    });
  });

  it("withdraw finalizer can finalize while paused, but non-finalizer cannot", async () => {
    await seedDeposit();

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("50", 18), parseUnits("50", 18)],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "completeWithdrawal",
        args: [1n],
      }),
      /AccessControl/,
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "pause",
      args: [],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const req = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getWithdrawalRequest",
      args: [1n],
    });

    assert.equal(Number(req[6]), 2);
  });

  it("only config manager can call config functions", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "addAllowedDepositToken",
        args: [ctx.usdc.address],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setDestinationChainAllowed",
        args: [1n, true],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setDestinationAssetAllowed",
        args: [8453n, ctx.usdc.address, true],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setExternalVaultAllowed",
        args: [ctx.usdc.address, true],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setPerformanceFee",
        args: [100n],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setFeeRecipient",
        args: [ctx.user.account.address],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setMinDeposit",
        args: [parseUnits("1", 18)],
      }),
      /AccessControl/,
    );
  });

  it("setDestinationAssetAllowed enforces destination chain allowlist", async () => {
    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setDestinationAssetAllowed",
        args: [9999n, ctx.usdc.address, true],
      }),
      /DestinationChainNotAllowed/,
    );
  });

  it("only relayer can call remote and controller entrypoints", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDeposit",
        args: [keccak256("0x1"), ctx.user.account.address, parseUnits("1", 18)],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDepositNonEvm",
        args: [keccak256("0x2"), 2423n, "user.near", parseUnits("1", 18)],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestWithdrawalController",
        args: [
          ctx.user.account.address,
          ctx.user.account.address as Hex,
          8453n,
          ctx.usdc.address,
          parseUnits("1", 18),
          parseUnits("1", 18),
          0n,
        ],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteWithdrawalRequest",
        args: [
          keccak256("0x3"),
          ctx.user.account.address,
          ctx.user.account.address as Hex,
          8453n,
          ctx.usdc.address,
          parseUnits("1", 18),
          parseUnits("1", 18),
        ],
      }),
      /AccessControl/,
    );
  });

  it("only asset manager can adjust assets and use external vault operations", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "adjustManagedAssets",
        args: [parseUnits("1", 18)],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "depositIntoExternalVault",
        args: [ZERO_ADDRESS, 1n],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "withdrawFromExternalVault",
        args: [ZERO_ADDRESS, 1n, ZERO_ADDRESS],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "redeemFromExternalVault",
        args: [ZERO_ADDRESS, 1n, ZERO_ADDRESS],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transferOut",
        args: [keccak256("0x55"), ctx.usdc.address, ctx.user.account.address, parseUnits("1", 6), keccak256("0x06")],
      }),
      /AccessControl/,
    );
  });

  it("asset manager transferOut keeps managed assets unchanged and enforces replay guard", async () => {
    await seedDeposit("1000");

    const ownerUsdcBefore = await ctx.publicClient.readContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "balanceOf",
      args: [ctx.owner.account.address],
    });
    const totalAssetsBefore = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "totalAssets",
      args: [],
    });

    const operationId = keccak256("0x9911");
    const reasonCode = keccak256("0xaabbcc");
    const txHash = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "transferOut",
      args: [operationId, ctx.usdc.address, ctx.owner.account.address, parseUnits("100", 6), reasonCode],
    });

    const event = await getEventArgs<TransferOutArgs>(ctx, txHash, "TransferOut");
    assert.equal(event.operationId.toLowerCase(), operationId.toLowerCase());
    assert.equal(event.token.toLowerCase(), ctx.usdc.address.toLowerCase());
    assert.equal(event.to.toLowerCase(), ctx.owner.account.address.toLowerCase());
    assert.equal(event.amountToken, parseUnits("100", 6));
    assert.equal(event.amountNormalized, parseUnits("100", 18));
    assert.equal(event.reasonCode.toLowerCase(), reasonCode.toLowerCase());

    const [ownerUsdcAfter, totalAssetsAfter] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.usdc.address,
        abi: ctx.usdc.abi,
        functionName: "balanceOf",
        args: [ctx.owner.account.address],
      }),
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "totalAssets",
        args: [],
      }),
    ]);

    assert.equal(ownerUsdcAfter, ownerUsdcBefore + parseUnits("100", 6));
    assert.equal(totalAssetsAfter, totalAssetsBefore);

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transferOut",
        args: [operationId, ctx.usdc.address, ctx.owner.account.address, parseUnits("1", 6), reasonCode],
      }),
      /OperationAlreadyProcessed/,
    );
  });

  it("asset manager external vault deposit requires config allowlist", async () => {
    await seedDeposit("500");

    const externalVault = await ctx.viem.deployContract(
      "DummyERC4626",
      [ctx.usdc.address, "Dummy Vault Share", "dUSDC"],
      { client: { wallet: ctx.owner } },
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "depositIntoExternalVault",
        args: [externalVault.address, parseUnits("100", 6)],
      }),
      /ExternalVaultNotAllowed/,
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setExternalVaultAllowed",
      args: [externalVault.address, true],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("100", 6)],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "withdrawFromExternalVault",
      args: [externalVault.address, parseUnits("25", 6), ZERO_ADDRESS],
    });
  });

  it("only upgrader can authorize UUPS upgrade", async () => {
    const newImpl = await ctx.viem.deployContract("HakoStableVault", [], {
      client: { wallet: ctx.owner },
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "upgradeToAndCall",
        args: [newImpl.address, "0x"],
      }),
      /AccessControl/,
    );
  });

  it("upgrader role can execute UUPS upgrade without breaking state", async () => {
    const beforeHwm = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "highWaterMark",
      args: [],
    });

    const newImpl = await ctx.viem.deployContract("HakoStableVault", [], {
      client: { wallet: ctx.owner },
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "upgradeToAndCall",
      args: [newImpl.address, "0x"],
    });

    const afterHwm = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "highWaterMark",
      args: [],
    });

    assert.equal(afterHwm, beforeHwm);
  });

  it("locked shares prevent transferring more than unlocked balance", async () => {
    await seedDeposit("1000");

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("300", 18), parseUnits("300", 18)],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transfer",
        args: [ctx.owner.account.address, parseUnits("701", 18)],
      }),
      /InsufficientUnlockedShares/,
    );

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "transfer",
      args: [ctx.owner.account.address, parseUnits("700", 18)],
    });
  });

  it("replay guards enforce unique cross-chain deposit and remote withdrawal ids", async () => {
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [keccak256("0xd1"), ctx.user.account.address, parseUnits("200", 18)],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDeposit",
        args: [keccak256("0xd1"), ctx.user.account.address, parseUnits("200", 18)],
      }),
      /DepositAlreadyProcessed/,
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteWithdrawalRequest",
      args: [
        keccak256("0xe1"),
        ctx.user.account.address,
        ctx.user.account.address as Hex,
        8453n,
        ctx.usdc.address,
        parseUnits("50", 18),
        parseUnits("50", 18),
      ],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteWithdrawalRequest",
        args: [
          keccak256("0xe1"),
          ctx.user.account.address,
          ctx.user.account.address as Hex,
          8453n,
          ctx.usdc.address,
          parseUnits("50", 18),
          parseUnits("50", 18),
        ],
      }),
      /RemoteWithdrawalAlreadyProcessed/,
    );
  });
});
