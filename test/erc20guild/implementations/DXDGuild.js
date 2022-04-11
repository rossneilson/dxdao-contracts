import * as helpers from "../../helpers";
const {
  createDAO,
  createAndSetupGuildToken,
  setAllVotesOnProposal,
} = require("../../helpers/guild");
const {
  BN,
  expectEvent,
  expectRevert,
  time,
} = require("@openzeppelin/test-helpers");

const DXDGuild = artifacts.require("DXDGuild.sol");
const PermissionRegistry = artifacts.require("PermissionRegistry.sol");
const ActionMock = artifacts.require("ActionMock.sol");

require("chai").should();

contract("DXDGuild", function (accounts) {
  const constants = helpers.constants;
  const TIMELOCK = new BN("60");
  const VOTE_GAS = new BN("50000"); // 50k
  const MAX_GAS_PRICE = new BN("8000000000"); // 8 gwei

  let walletScheme,
    org,
    actionMock,
    votingMachine,
    guildToken,
    dxdGuild,
    tokenVault,
    walletSchemeProposalId,
    walletSchemeProposalData;

  beforeEach(async function () {
    guildToken = await createAndSetupGuildToken(
      accounts.slice(0, 5),
      [0, 50, 100, 100, 250]
    );
    dxdGuild = await DXDGuild.new();
    const permissionRegistry = await PermissionRegistry.new();
    await permissionRegistry.initialize();

    const createDaoResult = await createDAO(dxdGuild, accounts);
    walletScheme = createDaoResult.walletScheme;
    votingMachine = createDaoResult.votingMachine;
    org = createDaoResult.org;
    actionMock = await ActionMock.new();
    await dxdGuild.methods[
      "initialize(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address)"
    ](
      guildToken.address,
      30,
      30,
      5000,
      1100,
      VOTE_GAS,
      MAX_GAS_PRICE,
      10,
      TIMELOCK,
      permissionRegistry.address,
      votingMachine.address
    );

    await time.increase(time.duration.seconds(1));

    tokenVault = await dxdGuild.getTokenVault();

    await guildToken.approve(tokenVault, 50, { from: accounts[1] });
    await guildToken.approve(tokenVault, 100, { from: accounts[2] });
    await guildToken.approve(tokenVault, 100, { from: accounts[3] });
    await guildToken.approve(tokenVault, 250, { from: accounts[4] });

    await dxdGuild.lockTokens(50, { from: accounts[1] });
    await dxdGuild.lockTokens(100, { from: accounts[2] });
    await dxdGuild.lockTokens(100, { from: accounts[3] });
    await dxdGuild.lockTokens(250, { from: accounts[4] });

    walletSchemeProposalData = helpers.encodeGenericCallData(
      org.avatar.address,
      actionMock.address,
      helpers.testCallFrom(org.avatar.address),
      0
    );
    const tx = await walletScheme.proposeCalls(
      [org.controller.address],
      [walletSchemeProposalData],
      [0],
      "Test Title",
      constants.SOME_HASH
    );
    walletSchemeProposalId = await helpers.getValueFromLogs(tx, "_proposalId");
    await new web3.eth.Contract(votingMachine.contract.abi).methods
      .vote(walletSchemeProposalId, 1, 0, constants.NULL_ADDRESS)
      .encodeABI();
  });

  describe("DXDGuild", function () {
    it("execute a positive vote on the voting machine from the dxd-guild", async function () {
      const DXDVotingMachineContract = await new web3.eth.Contract(
        votingMachine.contract.abi
      );
      const positiveVoteData = DXDVotingMachineContract.methods
        .vote(walletSchemeProposalId, 1, 0, constants.NULL_ADDRESS)
        .encodeABI();
      const negativeVoteData = DXDVotingMachineContract.methods
        .vote(walletSchemeProposalId, 2, 0, constants.NULL_ADDRESS)
        .encodeABI();

      await expectRevert(
        dxdGuild.createProposal(
          [votingMachine.address, votingMachine.address],
          [positiveVoteData, negativeVoteData],
          [0, 0],
          2,
          `vote on ${walletSchemeProposalId}`,
          constants.SOME_HASH,
          { from: accounts[1] }
        ),
        "ERC20Guild: Not enough votes to create proposal"
      );
      const tx = await dxdGuild.createProposal(
        [votingMachine.address, votingMachine.address],
        [positiveVoteData, negativeVoteData],
        [0, 0],
        2,
        `vote on ${walletSchemeProposalId}`,
        constants.SOME_HASH,
        { from: accounts[2] }
      );

      const proposalId = tx.logs[0].args.proposalId;

      await setAllVotesOnProposal({
        guild: dxdGuild,
        proposalId: proposalId,
        action: 1,
        account: accounts[1],
      });

      await expectRevert(
        dxdGuild.endProposal(proposalId),
        "ERC20Guild: Proposal hasn't ended yet"
      );

      await setAllVotesOnProposal({
        guild: dxdGuild,
        proposalId: proposalId,
        action: 1,
        account: accounts[2],
      });

      const txVote = await setAllVotesOnProposal({
        guild: dxdGuild,
        proposalId: proposalId,
        action: 1,
        account: accounts[3],
      });

      if (constants.ARC_GAS_PRICE > 1)
        expect(txVote.receipt.gasUsed).to.be.below(80000);

      expectEvent(txVote, "VoteAdded", { proposalId: proposalId });
      await time.increase(time.duration.seconds(31));
      const receipt = await dxdGuild.endProposal(proposalId);
      expectEvent(receipt, "ProposalStateChanged", {
        proposalId: proposalId,
        newState: "3",
      });
      await expectRevert(
        dxdGuild.endProposal(proposalId),
        "ERC20Guild: Proposal already executed"
      );

      //TO DO: Check more conditions of REP vote done on voting machine and dao

      const proposalInfo = await dxdGuild.getProposal(proposalId);
      assert.equal(
        proposalInfo.state,
        constants.WalletSchemeProposalState.executionSuccedd
      );
      assert.equal(proposalInfo.to[0], votingMachine.address);
      assert.equal(proposalInfo.value[0], 0);
    });
  });
});
