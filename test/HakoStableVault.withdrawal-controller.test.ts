import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { keccak256, parseUnits, type Hex } from "viem";
import { deployFixture } from "./fixtures.js";
import {
  ZERO_ADDRESS,
  type VaultTestCtx,
  approveAndDeposit,
  getEventArgs,
  pricePerShareX18,
  readSupplyAndAssets,
} from "./hakoStableVaultTestUtils.js";

type WithdrawalRequestedArgs = {
  requestId: bigint;
  owner: `0x${string}`;
  dstChainId: bigint;
  token: `0x${string}`;
  receiver: Hex;
  amountNormalized: bigint;
  sharesLocked: bigint;
};

type RemoteWithdrawalRequestRecordedArgs = {
  remoteRequestId: Hex;
  requestId: bigint;
  owner: `0x${string}`;
  dstChainId: bigint;
  token: `0x${string}`;
  receiver: Hex;
  amountNormalized: bigint;
  sharesLocked: bigint;
};

type WithdrawalRequestView = {
  owner: `0x${string}`;
  receiver: `0x${string}`;
  dstChainId: bigint;
  token: `0x${string}`;
  amountNormalized: bigint;
  sharesLocked: bigint;
  status: number;
};

const USDC_DECIMALS = 6;
const WITHDRAW_STATUS_PENDING = 1;
const WITHDRAW_STATUS_COMPLETED = 2;

function denormalizeToToken(amountNormalized: bigint, decimals: number): bigint {
  const factor = 10n ** BigInt(18 - decimals);
  return amountNormalized / factor;
}

describe("HakoStableVault withdrawal controller and remote request flows", () => {
  let ctx: VaultTestCtx;

  beforeEach(async () => {
    ctx = await deployFixture();
  });

  async function seedUserDeposit(amountUsdc: string) {
    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits(amountUsdc, USDC_DECIMALS),
      receiver: ctx.user.account.address,
    });
  }

  async function readRequest(requestId: bigint): Promise<WithdrawalRequestView> {
    const [owner, receiver, dstChainId, token, amountNormalized, sharesLocked, status] =
      await ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "getWithdrawalRequest",
        args: [requestId],
      });

    return {
      owner,
      receiver,
      dstChainId,
      token,
      amountNormalized,
      sharesLocked,
      status: Number(status),
    };
  }

  it("requestWithdrawalController creates request, increments nonce, and preserves PPS", async () => {
    await seedUserDeposit("1000");

    const txHash = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawalController",
      args: [
        ctx.user.account.address,
        ctx.user.account.address as Hex,
        8453n,
        ctx.usdc.address,
        parseUnits("100", 18),
        parseUnits("100", 18),
        0n,
      ],
    });

    const event = await getEventArgs<WithdrawalRequestedArgs>(ctx, txHash, "WithdrawalRequested");
    assert.equal(event.requestId, 1n);
    assert.equal(event.owner.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(event.amountNormalized, parseUnits("100", 18));
    assert.equal(event.sharesLocked, parseUnits("100", 18));

    const nonce = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "withdrawalNonce",
      args: [ctx.user.account.address],
    });
    assert.equal(nonce, 1n);

    const request = await readRequest(1n);
    assert.equal(request.receiver.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(request.status, WITHDRAW_STATUS_PENDING);

    const receiverData = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getWithdrawalReceiver",
      args: [1n],
    });
    assert.equal(receiverData.toLowerCase(), ctx.user.account.address.toLowerCase());

    const rawUsdc = denormalizeToToken(request.amountNormalized, USDC_DECIMALS);
    assert.equal(rawUsdc, parseUnits("100", USDC_DECIMALS));
    assert.equal(await pricePerShareX18(ctx), parseUnits("1", 18));
  });

  it("requestWithdrawalController rejects non-relayer caller", async () => {
    await seedUserDeposit("1000");

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
          parseUnits("100", 18),
          parseUnits("100", 18),
          0n,
        ],
      }),
      /AccessControl/,
    );
  });

  it("requestWithdrawalController rejects nonce mismatch and keeps nonce unchanged", async () => {
    await seedUserDeposit("1000");

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
          parseUnits("100", 18),
          parseUnits("100", 18),
          1n,
        ],
      }),
      /InvalidWithdrawalNonce/,
    );

    const nonce = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "withdrawalNonce",
      args: [ctx.user.account.address],
    });
    assert.equal(nonce, 0n);
  });

  it("requestWithdrawalController stores non-EVM receiver bytes while struct receiver is zero address", async () => {
    await seedUserDeposit("1000");

    const receiverBytes = "0x0102030405" as Hex;
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawalController",
      args: [ctx.user.account.address, receiverBytes, 8453n, ctx.usdc.address, parseUnits("50", 18), parseUnits("50", 18), 0n],
    });

    const request = await readRequest(1n);
    assert.equal(request.receiver.toLowerCase(), ZERO_ADDRESS.toLowerCase());

    const storedBytes = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getWithdrawalReceiver",
      args: [1n],
    });
    assert.equal(storedBytes.toLowerCase(), receiverBytes.toLowerCase());
  });

  it("requestWithdrawalController completion after pending deposits keeps final totals valid", async () => {
    await seedUserDeposit("1000");

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawalController",
      args: [
        ctx.user.account.address,
        ctx.user.account.address as Hex,
        8453n,
        ctx.usdc.address,
        parseUnits("200", 18),
        parseUnits("200", 18),
        0n,
      ],
    });

    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits("300", USDC_DECIMALS),
      receiver: ctx.user.account.address,
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [keccak256("0x9999aaaa"), ctx.owner.account.address, parseUnits("250", 18)],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const request = await readRequest(1n);
    assert.equal(request.status, WITHDRAW_STATUS_COMPLETED);

    const { supply, assets } = await readSupplyAndAssets(ctx);
    assert.equal(supply, parseUnits("1350", 18));
    assert.equal(assets, parseUnits("1350", 18));
    assert.equal(await pricePerShareX18(ctx), parseUnits("1", 18));
  });

  it("recordRemoteWithdrawalRequest creates pending request and emits remote event", async () => {
    await seedUserDeposit("1000");

    const remoteId = keccak256("0xa1a1a1");
    const receiverBytes = ctx.owner.account.address as Hex;
    const txHash = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteWithdrawalRequest",
      args: [
        remoteId,
        ctx.user.account.address,
        receiverBytes,
        8453n,
        ctx.usdc.address,
        parseUnits("110", 18),
        parseUnits("110", 18),
      ],
    });

    const event = await getEventArgs<RemoteWithdrawalRequestRecordedArgs>(ctx, txHash, "RemoteWithdrawalRequestRecorded");
    assert.equal(event.remoteRequestId.toLowerCase(), remoteId.toLowerCase());
    assert.equal(event.requestId, 1n);
    assert.equal(event.owner.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(event.receiver.toLowerCase(), receiverBytes.toLowerCase());
    assert.equal(event.amountNormalized, parseUnits("110", 18));

    const request = await readRequest(1n);
    assert.equal(request.status, WITHDRAW_STATUS_PENDING);
    assert.equal(request.amountNormalized, parseUnits("110", 18));
    assert.equal(request.sharesLocked, parseUnits("110", 18));

    const nonce = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "withdrawalNonce",
      args: [ctx.user.account.address],
    });
    assert.equal(nonce, 0n);
  });

  it("recordRemoteWithdrawalRequest rejects replayed remoteRequestId", async () => {
    await seedUserDeposit("1000");

    const remoteId = keccak256("0xbbbbcccc");
    const args = [
      remoteId,
      ctx.user.account.address,
      ctx.user.account.address as Hex,
      8453n,
      ctx.usdc.address,
      parseUnits("90", 18),
      parseUnits("90", 18),
    ] as const;

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteWithdrawalRequest",
      args,
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteWithdrawalRequest",
        args,
      }),
      /RemoteWithdrawalAlreadyProcessed/,
    );
  });

  it("recordRemoteWithdrawalRequest failure does not consume remoteRequestId", async () => {
    await seedUserDeposit("1000");

    const remoteId = keccak256("0xddddaaaa");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteWithdrawalRequest",
        args: [remoteId, ctx.user.account.address, ctx.user.account.address as Hex, 8453n, ctx.usdc.address, 0n, parseUnits("1", 18)],
      }),
      /AmountZero/,
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteWithdrawalRequest",
      args: [
        remoteId,
        ctx.user.account.address,
        ctx.user.account.address as Hex,
        8453n,
        ctx.usdc.address,
        parseUnits("75", 18),
        parseUnits("75", 18),
      ],
    });

    const req = await readRequest(1n);
    assert.equal(req.amountNormalized, parseUnits("75", 18));
    assert.equal(req.status, WITHDRAW_STATUS_PENDING);
  });

  it("recordRemoteWithdrawalRequest rejects non-relayer caller", async () => {
    await seedUserDeposit("1000");

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteWithdrawalRequest",
        args: [
          keccak256("0x11112222"),
          ctx.user.account.address,
          ctx.user.account.address as Hex,
          8453n,
          ctx.usdc.address,
          parseUnits("50", 18),
          parseUnits("50", 18),
        ],
      }),
      /AccessControl/,
    );
  });

  it("recordRemoteWithdrawalRequest with non-EVM receiver stores bytes and zero struct receiver", async () => {
    await seedUserDeposit("1000");

    const receiverBytes = "0xaabbccddeeff" as Hex;
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteWithdrawalRequest",
      args: [
        keccak256("0x55556666"),
        ctx.user.account.address,
        receiverBytes,
        8453n,
        ctx.usdc.address,
        parseUnits("100", 18),
        parseUnits("100", 18),
      ],
    });

    const req = await readRequest(1n);
    assert.equal(req.receiver.toLowerCase(), ZERO_ADDRESS.toLowerCase());

    const storedBytes = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getWithdrawalReceiver",
      args: [1n],
    });
    assert.equal(storedBytes.toLowerCase(), receiverBytes.toLowerCase());
  });

  it("recordRemoteWithdrawalRequest pending value remains stable through deposits and completion", async () => {
    await seedUserDeposit("1000");

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteWithdrawalRequest",
      args: [
        keccak256("0x77778888"),
        ctx.user.account.address,
        ctx.user.account.address as Hex,
        8453n,
        ctx.usdc.address,
        parseUnits("200", 18),
        parseUnits("200", 18),
      ],
    });

    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits("400", USDC_DECIMALS),
      receiver: ctx.user.account.address,
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [keccak256("0xaabb1122"), ctx.owner.account.address, parseUnits("300", 18)],
    });

    const pending = await readRequest(1n);
    assert.equal(pending.amountNormalized, parseUnits("200", 18));
    assert.equal(denormalizeToToken(pending.amountNormalized, USDC_DECIMALS), parseUnits("200", USDC_DECIMALS));

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const completed = await readRequest(1n);
    assert.equal(completed.status, WITHDRAW_STATUS_COMPLETED);

    const { supply, assets } = await readSupplyAndAssets(ctx);
    assert.equal(supply, parseUnits("1500", 18));
    assert.equal(assets, parseUnits("1500", 18));
    assert.equal(await pricePerShareX18(ctx), parseUnits("1", 18));
  });

  it("controller and remote flows both enforce destination allowlist", async () => {
    await seedUserDeposit("1000");

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setDestinationChainAllowed",
      args: [8453n, false],
    });

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
      /DestinationChainNotAllowed/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteWithdrawalRequest",
        args: [
          keccak256("0xabcabc"),
          ctx.user.account.address,
          ctx.user.account.address as Hex,
          8453n,
          ctx.usdc.address,
          parseUnits("10", 18),
          parseUnits("10", 18),
        ],
      }),
      /DestinationChainNotAllowed/,
    );
  });
});
