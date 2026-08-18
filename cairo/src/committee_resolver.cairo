//! Settles a Veilcast market by a vote of named jurors, for questions no feed can answer.
//!
//! A price market settles itself from Pragma. Everything else ("did this team win", "did this ship
//! by Friday") needs judgment, and one address holding that judgment is a single point of trust.
//! This contract is the middle ground: a market names this contract as its resolver, and a fixed
//! panel of jurors, set when the market opens, votes on the outcome. The first outcome to reach the
//! quorum settles the market, and the caller of that last vote is just whoever paid the gas.
//!
//! The jury is public and so is every vote. That is the same split the whole of Veilcast runs on:
//! the resolution is out in the open so it can be checked, and what stays private is who bet on it.
//!
//! There is no admin. A panel that deadlocks cannot settle a market, and rather than give anyone a
//! casting vote, a deadlock is left to the market's own rule: 30 days past the close, anyone can
//! void it and every stake is refundable.

use starknet::ContractAddress;

/// A juror's choice: an outcome index to settle on, or `VOID_CHOICE` to cancel the market. Kept as
/// one `u8` so a vote is one storage slot and the tally is one map.
pub const VOID_CHOICE: u8 = 0xFF;

/// The panel bound to a market when it was opened.
#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct Committee {
    /// How many jurors sit on this market. Zero means no committee market has this id.
    pub n_jurors: u8,
    /// Votes for one choice needed to settle. `1 <= quorum <= n_jurors`.
    pub quorum: u8,
    /// The market's outcome count, so a vote can be checked without reading the market back.
    pub n_outcomes: u8,
    /// Bets close, and voting opens, at this timestamp. A juror judges the result after the event,
    /// never before it.
    pub close_at: u64,
    /// Set once the panel has settled or voided the market, so nothing happens to it twice.
    pub decided: bool,
}

#[starknet::interface]
pub trait ICommitteeResolver<TState> {
    /// Opens a market on the Veilcast market contract with this contract as its resolver, judged by
    /// `jurors` with `quorum` votes needed to settle. Returns the new market's id. Permissionless:
    /// whoever opens it picks the panel and becomes the fee recipient, and a bettor reads the panel
    /// on the board before staking anything.
    fn open_committee_market(
        ref self: TState,
        question: ByteArray,
        outcome_labels: Array<ByteArray>,
        close_at: u64,
        category: felt252,
        fee_bps: u16,
        jurors: Array<ContractAddress>,
        quorum: u8,
    ) -> u64;

    /// Casts the caller's one vote for `choice` on a closed market: an outcome index, or
    /// `VOID_CHOICE` to cancel. When a choice reaches the quorum this settles the market in the
    /// same transaction. A juror votes once and cannot change it.
    fn vote(ref self: TState, market_id: u64, choice: u8);

    fn get_committee(self: @TState, market_id: u64) -> Committee;
    /// Votes cast so far for one choice.
    fn get_votes(self: @TState, market_id: u64, choice: u8) -> u8;
    fn is_juror(self: @TState, market_id: u64, account: ContractAddress) -> bool;
    fn has_voted(self: @TState, market_id: u64, account: ContractAddress) -> bool;
    /// The choice a juror cast, or `VOID_CHOICE` if they voted void or have not voted (use
    /// `has_voted` to tell those apart).
    fn vote_of(self: @TState, market_id: u64, account: ContractAddress) -> u8;
    fn get_market(self: @TState) -> ContractAddress;
}

pub mod errors {
    pub const ZERO_MARKET: felt252 = 'ZERO_MARKET';
    pub const NO_COMMITTEE: felt252 = 'NO_COMMITTEE';
    pub const TOO_FEW_JURORS: felt252 = 'TOO_FEW_JURORS';
    pub const TOO_MANY_JURORS: felt252 = 'TOO_MANY_JURORS';
    pub const BAD_QUORUM: felt252 = 'BAD_QUORUM';
    pub const DUPLICATE_JUROR: felt252 = 'DUPLICATE_JUROR';
    pub const ZERO_JUROR: felt252 = 'ZERO_JUROR';
    pub const NOT_A_JUROR: felt252 = 'NOT_A_JUROR';
    pub const ALREADY_VOTED: felt252 = 'ALREADY_VOTED';
    pub const VOTING_NOT_OPEN: felt252 = 'VOTING_NOT_OPEN';
    pub const ALREADY_DECIDED: felt252 = 'ALREADY_DECIDED';
    pub const BAD_CHOICE: felt252 = 'BAD_CHOICE';
}
// __COMMITTEE_CONTRACT__

/// A panel no larger than this. A bettor should be able to read the whole jury before staking, and
/// every juror is a storage write when the market opens, so the panel is kept small on purpose.
pub const MAX_JURORS: u8 = 16;

#[starknet::contract]
pub mod CommitteeResolver {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use veilcast::interface::{IVeilcastMarketDispatcher, IVeilcastMarketDispatcherTrait};
    use super::{Committee, ICommitteeResolver, MAX_JURORS, VOID_CHOICE, errors};

    #[storage]
    struct Storage {
        market: ContractAddress,
        committees: Map<u64, Committee>,
        /// Who sits on a market's panel.
        jurors: Map<(u64, ContractAddress), bool>,
        /// A juror's cast choice, meaningful only once `voted` is set for them.
        ballots: Map<(u64, ContractAddress), u8>,
        voted: Map<(u64, ContractAddress), bool>,
        /// Running tally per choice: `(market_id, choice) -> votes`.
        tally: Map<(u64, u8), u8>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        CommitteeMarketOpened: CommitteeMarketOpened,
        VoteCast: VoteCast,
        CommitteeDecided: CommitteeDecided,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CommitteeMarketOpened {
        #[key]
        pub market_id: u64,
        pub n_jurors: u8,
        pub quorum: u8,
    }

    /// A juror's vote, published as it is cast. The panel and its votes are public by design, so a
    /// settlement can be checked against who voted for what.
    #[derive(Drop, starknet::Event)]
    pub struct VoteCast {
        #[key]
        pub market_id: u64,
        #[key]
        pub juror: ContractAddress,
        pub choice: u8,
        pub votes_for_choice: u8,
    }

    /// The choice that reached quorum and settled the market.
    #[derive(Drop, starknet::Event)]
    pub struct CommitteeDecided {
        #[key]
        pub market_id: u64,
        pub choice: u8,
    }

    #[constructor]
    fn constructor(ref self: ContractState, market: ContractAddress) {
        assert(market.is_non_zero(), errors::ZERO_MARKET);
        self.market.write(market);
    }

    #[abi(embed_v0)]
    pub impl CommitteeResolverImpl of ICommitteeResolver<ContractState> {
        fn open_committee_market(
            ref self: ContractState,
            question: ByteArray,
            outcome_labels: Array<ByteArray>,
            close_at: u64,
            category: felt252,
            fee_bps: u16,
            jurors: Array<ContractAddress>,
            quorum: u8,
        ) -> u64 {
            let n_jurors = jurors.len();
            assert(n_jurors >= 1, errors::TOO_FEW_JURORS);
            assert(n_jurors <= MAX_JURORS.into(), errors::TOO_MANY_JURORS);
            // A quorum of one is a single trusted resolver by another name, but that is the
            // opener's call to make and a bettor can see it; zero, or more than the whole panel,
            // cannot be satisfied honestly.
            assert(quorum >= 1 && quorum.into() <= n_jurors, errors::BAD_QUORUM);
            let n_outcomes: u8 = outcome_labels.len().try_into().unwrap();

            // The market checks the labels, the resolver and the close, and hands out ids in
            // sequence, so a committee written against the returned id can never collide.
            let market_id = IVeilcastMarketDispatcher { contract_address: self.market.read() }
                .create_market(
                    :question,
                    :outcome_labels,
                    resolver: get_contract_address(),
                    :close_at,
                    :category,
                    :fee_bps,
                    // This contract cannot move a token balance, so the fee goes to whoever opened
                    // the market rather than being stranded here.
                    fee_recipient: get_caller_address(),
                );

            for juror in jurors {
                assert(juror.is_non_zero(), errors::ZERO_JUROR);
                let seat = self.jurors.entry((market_id, juror));
                // A double-counted juror would weaken the quorum they were meant to strengthen.
                assert(!seat.read(), errors::DUPLICATE_JUROR);
                seat.write(true);
            }

            self
                .committees
                .entry(market_id)
                .write(
                    Committee {
                        n_jurors: n_jurors.try_into().unwrap(),
                        quorum,
                        n_outcomes,
                        close_at,
                        decided: false,
                    },
                );
            self
                .emit(
                    CommitteeMarketOpened {
                        market_id, n_jurors: n_jurors.try_into().unwrap(), quorum,
                    },
                );
            market_id
        }

        fn vote(ref self: ContractState, market_id: u64, choice: u8) {
            let mut committee = self.committees.entry(market_id).read();
            assert(committee.n_jurors.is_non_zero(), errors::NO_COMMITTEE);
            assert(!committee.decided, errors::ALREADY_DECIDED);
            assert(
                self.jurors.entry((market_id, get_caller_address())).read(), errors::NOT_A_JUROR,
            );
            // Judgment comes after the event, so voting opens when betting closes. Before that the
            // market would refuse the settlement anyway.
            assert(get_block_timestamp() >= committee.close_at, errors::VOTING_NOT_OPEN);
            assert(choice < committee.n_outcomes || choice == VOID_CHOICE, errors::BAD_CHOICE);

            let caller = get_caller_address();
            let ballot = self.voted.entry((market_id, caller));
            assert(!ballot.read(), errors::ALREADY_VOTED);
            ballot.write(true);
            self.ballots.entry((market_id, caller)).write(choice);

            let tally_entry = self.tally.entry((market_id, choice));
            let votes_for_choice = tally_entry.read() + 1;
            tally_entry.write(votes_for_choice);
            self.emit(VoteCast { market_id, juror: caller, choice, votes_for_choice });

            if votes_for_choice >= committee.quorum {
                committee.decided = true;
                self.committees.entry(market_id).write(committee);
                let market = IVeilcastMarketDispatcher { contract_address: self.market.read() };
                if choice == VOID_CHOICE {
                    market.void(market_id);
                } else {
                    market.resolve(market_id, winning_outcome: choice);
                }
                self.emit(CommitteeDecided { market_id, choice });
            }
        }

        fn get_committee(self: @ContractState, market_id: u64) -> Committee {
            self.committees.entry(market_id).read()
        }

        fn get_votes(self: @ContractState, market_id: u64, choice: u8) -> u8 {
            self.tally.entry((market_id, choice)).read()
        }

        fn is_juror(self: @ContractState, market_id: u64, account: ContractAddress) -> bool {
            self.jurors.entry((market_id, account)).read()
        }

        fn has_voted(self: @ContractState, market_id: u64, account: ContractAddress) -> bool {
            self.voted.entry((market_id, account)).read()
        }

        fn vote_of(self: @ContractState, market_id: u64, account: ContractAddress) -> u8 {
            self.ballots.entry((market_id, account)).read()
        }

        fn get_market(self: @ContractState) -> ContractAddress {
            self.market.read()
        }
    }
}
