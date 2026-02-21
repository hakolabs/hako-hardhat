import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("HakoStableGateway", (m) => {
  const initialOwner = m.getParameter<string>("initialOwner");
  const allowedDepositTokens = m.getParameter<string[]>("allowedDepositTokens", []);
  const minDepositNormalized = m.getParameter("minDepositNormalized", 10n ** 15n);

  const implementation = m.contract("HakoStableGateway", []);
  const initData = m.encodeFunctionCall(implementation, "initialize", [
    initialOwner,
    allowedDepositTokens,
    minDepositNormalized,
  ]);

  const proxy = m.contract("HakoProxy", [implementation, initData], {
    id: "HakoStableGatewayProxy",
  });

  const gateway = m.contractAt("HakoStableGateway", proxy, {
    id: "HakoStableGatewayInstance",
  });

  return { implementation, proxy, gateway };
});
