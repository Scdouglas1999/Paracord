use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use paracord_models::id::{ChannelId, EmojiId, GuildId, MessageId, RoleId, UserId};

/// Custom epoch: 2024-01-01T00:00:00Z
const PARACORD_EPOCH: u64 = 1_704_067_200_000;

/// Maximum sequence value (12 bits).
const SEQUENCE_MASK: u64 = 0xFFF;

/// Snowflake generator state. Not `Sync` by itself; the process-global instance
/// is guarded by a [`Mutex`]. Tests construct isolated instances so they never
/// contaminate the shared clock/sequence state.
struct Generator {
    last_timestamp: u64,
    sequence: u64,
}

impl Generator {
    const fn new() -> Self {
        Self {
            last_timestamp: 0,
            sequence: 0,
        }
    }

    /// Produce the next id using `clock` as the millisecond time source.
    ///
    /// The clock is injectable so tests can drive clock skew and sequence
    /// exhaustion deterministically; production always passes [`current_timestamp`].
    fn next(&mut self, worker_id: u16, mut clock: impl FnMut() -> u64) -> i64 {
        // Monotonic guard: never let the timestamp regress below the last one we
        // used, even if the wall clock steps backwards. This preserves ID ordering
        // and uniqueness across clock corrections without panicking.
        let mut timestamp = clock().max(self.last_timestamp);

        if timestamp == self.last_timestamp {
            self.sequence = (self.sequence + 1) & SEQUENCE_MASK;
            if self.sequence == 0 {
                // Sequence overflow within this millisecond: advance to the next
                // millisecond. Rather than busy-spinning, yield between polls so
                // other threads make progress while we wait for the clock to tick.
                loop {
                    std::thread::yield_now();
                    let now = clock();
                    if now > self.last_timestamp {
                        timestamp = now;
                        break;
                    }
                }
            }
        } else {
            self.sequence = 0;
        }

        self.last_timestamp = timestamp;
        let seq = self.sequence;
        let id = (timestamp << 22) | ((worker_id as u64 & 0x3FF) << 12) | seq;
        id as i64
    }
}

static STATE: Mutex<Generator> = Mutex::new(Generator::new());

/// Read the wall clock as milliseconds since the Paracord epoch.
///
/// Handles a clock that has stepped below the epoch (e.g. a large NTP correction)
/// gracefully by saturating to `0` instead of panicking. The monotonic guard in
/// [`Generator::next`] then keeps generated IDs from regressing.
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
        .saturating_sub(PARACORD_EPOCH)
}

/// Generate a Snowflake ID.
/// Format: 42 bits timestamp | 10 bits worker | 12 bits sequence
pub fn generate(worker_id: u16) -> i64 {
    let mut state = STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.next(worker_id, current_timestamp)
}

#[inline]
pub fn generate_user_id(worker_id: u16) -> UserId {
    UserId::from(generate(worker_id))
}

#[inline]
pub fn generate_guild_id(worker_id: u16) -> GuildId {
    GuildId::from(generate(worker_id))
}

#[inline]
pub fn generate_channel_id(worker_id: u16) -> ChannelId {
    ChannelId::from(generate(worker_id))
}

#[inline]
pub fn generate_message_id(worker_id: u16) -> MessageId {
    MessageId::from(generate(worker_id))
}

#[inline]
pub fn generate_role_id(worker_id: u16) -> RoleId {
    RoleId::from(generate(worker_id))
}

#[inline]
pub fn generate_emoji_id(worker_id: u16) -> EmojiId {
    EmojiId::from(generate(worker_id))
}

/// Extract the Unix timestamp (ms) from a snowflake.
pub fn timestamp_millis(id: i64) -> u64 {
    ((id as u64) >> 22) + PARACORD_EPOCH
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn ids_are_unique_and_monotonic_across_sequence_overflow() {
        // Isolated generator driven by a virtual clock that reports the same
        // millisecond for a run of reads and then ticks forward. This keeps many
        // consecutive ids on the same tick so the 12-bit sequence (4096) overflows
        // and the generator must roll to the next millisecond. Every read advances
        // an internal counter, so the overflow loop is guaranteed to observe a later
        // millisecond and terminate.
        let mut gen = Generator::new();
        let reads = AtomicU64::new(0);
        // ms = reads / 10000 + 1: the clock stays on the same millisecond for 10000
        // reads (> the 4096 sequence space) so the sequence overflows before the ms
        // ticks, forcing the generator into its next-millisecond rollover branch.
        // Because every read (including the polls inside the overflow loop) advances
        // the counter, the clock is guaranteed to eventually tick and the loop ends.
        let clock = || reads.fetch_add(1, Ordering::Relaxed) / 10000 + 1;

        let count = 4096 * 3;
        let mut ids = Vec::with_capacity(count);
        let mut seen = HashSet::with_capacity(count);
        for _ in 0..count {
            let id = gen.next(1, clock);
            assert!(seen.insert(id), "duplicate snowflake id generated: {id}");
            ids.push(id);
        }
        for pair in ids.windows(2) {
            assert!(
                pair[1] > pair[0],
                "ids must be strictly monotonically increasing: {} !> {}",
                pair[1],
                pair[0]
            );
        }
    }

    #[test]
    fn tight_loop_real_clock_stays_unique_and_monotonic() {
        // Exercise the real production path (global STATE + wall clock) with more
        // than one millisecond's worth of ids in a tight loop.
        let count = 4096 * 3;
        let mut ids = Vec::with_capacity(count);
        let mut seen = HashSet::with_capacity(count);
        for _ in 0..count {
            let id = generate(1);
            assert!(seen.insert(id), "duplicate snowflake id generated: {id}");
            ids.push(id);
        }
        for pair in ids.windows(2) {
            assert!(pair[1] > pair[0], "ids must be strictly increasing");
        }
    }

    #[test]
    fn backwards_clock_does_not_panic_and_stays_monotonic() {
        // Isolated generator: a clock that advances then jumps backwards (even
        // below the epoch, i.e. saturated to 0) must not panic and must not regress
        // generated ids.
        let mut gen = Generator::new();
        let ts_forward = gen.next(0, || 5_000);
        // Wall clock steps to before the epoch, saturating to 0.
        let ts_backward_1 = gen.next(0, || 0);
        let ts_backward_2 = gen.next(0, || 0);

        assert!(
            ts_backward_1 > ts_forward,
            "a backwards clock must not produce a regressing id"
        );
        assert!(
            ts_backward_2 > ts_backward_1,
            "monotonic guard holds across repeated backwards steps"
        );
    }

    #[test]
    fn current_timestamp_saturates_before_epoch_without_panic() {
        // current_timestamp must not underflow/panic; on any sane machine it is
        // well past the epoch, but the saturating subtraction guarantees no panic.
        let _ = current_timestamp();
        // An injected pre-epoch clock (0) must still yield a valid, completing id.
        let mut gen = Generator::new();
        let id = gen.next(0, || 0);
        assert!(id >= 0);
    }

    #[test]
    fn worker_id_is_encoded_in_the_id() {
        let mut gen = Generator::new();
        let id = gen.next(0x2AB, || 1); // 10-bit worker id
        let worker = ((id as u64) >> 12) & 0x3FF;
        assert_eq!(worker, 0x2AB);
    }
}
