import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("HakoStableVault", (m) => {
  const name = m.getParameter("name", "Hako Stable");
  const symbol = m.getParameter("symbol", "hSTBL");
  const initialOwner = m.getParameter<string>("initialOwner");
  const allowedDepositTokens = m.getParameter<string[]>("allowedDepositTokens", []);

  const implementation = m.contract("HakoStableVault", []);
  const initData = m.encodeFunctionCall(implementation, "initialize", [
    name,
    symbol,
    initialOwner,
    allowedDepositTokens,
  ]);

  const proxy = m.contract("HakoProxy", [implementation, initData], {
    id: "HakoStableVaultProxy",
  });

  const vault = m.contractAt("HakoStableVault", proxy, {
    id: "HakoStableVaultInstance",
  });

  return { implementation, proxy, vault };
});
