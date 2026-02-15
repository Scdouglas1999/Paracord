use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Custom epoch: 2024-01-01T00:00:00Z
const PARACORD_EPOCH: u64 = 1_704_067_200_000;

struct SnowflakeState {
    last_timestamp: u64,
    sequence: u64,
}

static STATE: Mutex<SnowflakeState> = Mutex::new(SnowflakeState {
    last_timestamp: 0,
    sequence: 0,
});

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time went backwards")
        .as_millis() as u64
        - PARACORD_EPOCH
}

/// Generate a Snowflake ID.
/// Format: 42 bits timestamp | 10 bits worker | 12 bits sequence
pub fn generate(worker_id: u16) -> i64 {
    let mut state = STATE.lock().unwrap();

    let mut timestamp = current_timestamp();

    if timestamp == state.last_timestamp {
        state.sequence = (state.sequence + 1) & 0xFFF;
        if state.sequence == 0 {
            // Sequence overflow — busy-wait until the next millisecond
            while timestamp <= state.last_timestamp {
                drop(state);
                std::hint::spin_loop();
                state = STATE.lock().unwrap();
                timestamp = current_timestamp();
            }
        }
    } else {
        state.sequence = 0;
    }

    state.last_timestamp = timestamp;
    let seq = state.sequence;

    let id = (timestamp << 22) | ((worker_id as u64 & 0x3FF) << 12) | seq;
    id as i64
}

/// Extract the Unix timestamp (ms) from a snowflake.
pub fn timestamp_millis(id: i64) -> u64 {
    ((id as u64) >> 22) + PARACORD_EPOCH
}

