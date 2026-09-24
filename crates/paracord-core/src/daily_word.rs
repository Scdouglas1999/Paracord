//! Daily word: a five-letter word puzzle with six guesses, one word per UTC day,
//! the same word for everyone on the instance.
//!
//! The word lists are compiled in (see `data/words/LICENSE-SOURCES.md`). The
//! answer for a day comes from a shuffled order of the answer list keyed by a
//! secret derived from the instance's JWT secret, so reading the source is not
//! enough to know tomorrow's word, and no word repeats until the whole list has
//! been used. The server stores each day's answer the first time it is needed,
//! so a later change to the list or the secret never changes a day in progress.

use chrono::{DateTime, Duration, NaiveDate, NaiveTime, Utc};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::LazyLock;

pub const WORD_LEN: usize = 5;
pub const MAX_GUESSES: usize = 6;

const ANSWERS_TEXT: &str = include_str!("../data/words/answers.txt");
const ALLOWED_TEXT: &str = include_str!("../data/words/allowed.txt");
const DEFINITIONS_TEXT: &str = include_str!("../data/words/definitions.tsv");

const KEY_SALT: &[u8] = b"paracord-daily-word";
const KEY_LABEL: &[u8] = b"answer-order-v1";

static ANSWERS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    ANSWERS_TEXT
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect()
});

static ALLOWED: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    ALLOWED_TEXT
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .chain(ANSWERS.iter().copied())
        .collect()
});

static DEFINITIONS: LazyLock<HashMap<&'static str, Definition>> = LazyLock::new(|| {
    DEFINITIONS_TEXT
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let word = parts.next()?;
            let part_of_speech = parts.next()?;
            let text = parts.next()?;
            Some((
                word,
                Definition {
                    part_of_speech,
                    text,
                },
            ))
        })
        .collect()
});

/// A short dictionary definition shipped with the answer list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Definition {
    pub part_of_speech: &'static str,
    pub text: &'static str,
}

/// What one letter of a guess says about the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LetterState {
    /// Right letter, right place.
    Correct,
    /// In the word, somewhere else.
    Present,
    /// Not in the word (or every copy of it is already accounted for).
    Absent,
}

/// Why a guess was refused without using up a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuessError {
    /// Not five letters A to Z.
    Shape,
    /// Five letters, but not a word on the list.
    NotAWord,
}

pub fn answer_count() -> usize {
    ANSWERS.len()
}

pub fn is_answer(word: &str) -> bool {
    ANSWERS.contains(&word)
}

pub fn is_allowed(word: &str) -> bool {
    ALLOWED.contains(word)
}

pub fn definition(word: &str) -> Option<Definition> {
    DEFINITIONS.get(word).copied()
}

/// Lowercase a guess and check it against the allowed list.
pub fn normalize_guess(raw: &str) -> Result<String, GuessError> {
    let word = raw.trim().to_ascii_lowercase();
    if word.len() != WORD_LEN || !word.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return Err(GuessError::Shape);
    }
    if !is_allowed(&word) {
        return Err(GuessError::NotAWord);
    }
    Ok(word)
}

/// Score a guess against the answer.
///
/// Exact matches are marked first. Each remaining letter of the guess is then
/// marked present only while the answer still has an unmatched copy of it, left
/// to right, so a letter guessed twice against an answer holding it once shows
/// once.
pub fn score(guess: &str, answer: &str) -> [LetterState; WORD_LEN] {
    let guess = guess.as_bytes();
    let answer = answer.as_bytes();
    debug_assert_eq!(guess.len(), WORD_LEN);
    debug_assert_eq!(answer.len(), WORD_LEN);
    let mut states = [LetterState::Absent; WORD_LEN];
    let mut unmatched = [0_u8; 26];
    for index in 0..WORD_LEN {
        if guess[index] == answer[index] {
            states[index] = LetterState::Correct;
        } else {
            unmatched[usize::from(answer[index] - b'a')] += 1;
        }
    }
    for index in 0..WORD_LEN {
        if states[index] == LetterState::Correct {
            continue;
        }
        let slot = &mut unmatched[usize::from(guess[index] - b'a')];
        if *slot > 0 {
            *slot -= 1;
            states[index] = LetterState::Present;
        }
    }
    states
}

/// The UTC day puzzle 1 was played.
pub fn first_day() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 1, 1).expect("a valid calendar date")
}

/// The puzzle number for a UTC day. Puzzle 1 is 2026-01-01.
pub fn puzzle_for(date: NaiveDate) -> i64 {
    (date - first_day()).num_days() + 1
}

/// The UTC day a puzzle belongs to.
pub fn date_for(puzzle: i64) -> NaiveDate {
    first_day() + Duration::days(puzzle - 1)
}

/// Today's puzzle at `now`.
pub fn puzzle_at(now: DateTime<Utc>) -> i64 {
    puzzle_for(now.date_naive())
}

/// When the next word arrives: the coming midnight UTC.
pub fn next_puzzle_at(now: DateTime<Utc>) -> DateTime<Utc> {
    let tomorrow = now.date_naive() + Duration::days(1);
    tomorrow.and_time(NaiveTime::MIN).and_utc()
}

/// The key that orders the answers, derived from the instance's JWT secret.
pub fn order_key(jwt_secret: &str) -> [u8; 32] {
    paracord_util::keyed::derive_key(jwt_secret.as_bytes(), KEY_SALT, KEY_LABEL)
}

/// The answer the keyed order gives for a puzzle.
///
/// The list is walked in cycles: cycle `c` is every answer sorted by a keyed
/// hash of `c` and the word, so each cycle is a fresh shuffle and no word comes
/// twice inside one.
pub fn answer_for(key: &[u8; 32], puzzle: i64) -> &'static str {
    let answers = &*ANSWERS;
    let count = answers.len() as i64;
    let index = puzzle - 1;
    let cycle = index.div_euclid(count);
    let position = index.rem_euclid(count) as usize;
    let mut order: Vec<(u64, usize)> = answers
        .iter()
        .enumerate()
        .map(|(slot, word)| {
            let input = format!("{cycle}:{word}");
            (paracord_util::keyed::keyed_u64(key, input.as_bytes()), slot)
        })
        .collect();
    order.sort_unstable();
    answers[order[position].1]
}

tokio::task_local! {
    static NOW: DateTime<Utc>;
}

/// The time the daily word runs on. The wall clock, unless a test set another
/// one with [`with_now`].
pub fn now() -> DateTime<Utc> {
    NOW.try_with(|now| *now).unwrap_or_else(|_| Utc::now())
}

/// Run `future` with [`now`] reading `at`. For tests: the clock is scoped to
/// the task, so tests running in parallel never see each other's time.
pub async fn with_now<F: Future>(at: DateTime<Utc>, future: F) -> F::Output {
    NOW.scope(at, future).await
}

/// One stored day, as streak and distribution math needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayResult {
    pub puzzle: i64,
    pub guess_count: i64,
    pub finished: bool,
    pub solved: bool,
}

/// A person's record across every day they played.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stats {
    /// Days finished, plus earlier days started and left unfinished.
    pub played: i64,
    pub solved: i64,
    /// Played days that were not solved.
    pub missed: i64,
    pub current_streak: i64,
    pub max_streak: i64,
    /// Solves in 1 through 6 guesses.
    pub distribution: [i64; MAX_GUESSES],
}

/// Streaks and distribution from stored days.
///
/// A streak is a run of consecutive days solved. A day that was missed, left
/// unfinished after it ended, or never opened ends it. Today only counts once
/// it is finished: before that the streak running through yesterday stands.
pub fn stats(results: &[DayResult], today: i64) -> Stats {
    let mut days: Vec<DayResult> = results
        .iter()
        .copied()
        .filter(|day| {
            day.puzzle <= today && (day.finished || (day.puzzle < today && day.guess_count > 0))
        })
        .collect();
    days.sort_by_key(|day| day.puzzle);

    let mut distribution = [0_i64; MAX_GUESSES];
    let mut solved = 0;
    let mut max_streak = 0;
    let mut run = 0;
    let mut last_solved: Option<i64> = None;
    for day in &days {
        if day.solved {
            solved += 1;
            if let Some(slot) = usize::try_from(day.guess_count - 1)
                .ok()
                .filter(|slot| *slot < MAX_GUESSES)
            {
                distribution[slot] += 1;
            }
            run = if last_solved == Some(day.puzzle - 1) {
                run + 1
            } else {
                1
            };
            last_solved = Some(day.puzzle);
            max_streak = max_streak.max(run);
        } else {
            run = 0;
            last_solved = None;
        }
    }

    let today_result = days.iter().find(|day| day.puzzle == today);
    let current_streak = match today_result {
        Some(day) if day.solved => run,
        Some(_) => 0,
        None if last_solved == Some(today - 1) => run,
        None => 0,
    };

    let played = days.len() as i64;
    Stats {
        played,
        solved,
        missed: played - solved,
        current_streak,
        max_streak,
        distribution,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use LetterState::{Absent as A, Correct as C, Present as P};

    #[test]
    fn lists_load_and_every_answer_is_allowed() {
        assert!(answer_count() > 1500, "{}", answer_count());
        assert!(ALLOWED.len() > 8000);
        for word in ANSWERS.iter() {
            assert_eq!(word.len(), WORD_LEN, "{word}");
            assert!(is_allowed(word), "{word}");
        }
        let unique: HashSet<_> = ANSWERS.iter().collect();
        assert_eq!(unique.len(), ANSWERS.len());
        assert!(definition("house").is_some());
        for word in DEFINITIONS.keys() {
            assert!(is_answer(word), "{word}");
        }
    }

    #[test]
    fn scoring_handles_repeated_letters() {
        assert_eq!(score("crane", "crane"), [C, C, C, C, C]);
        assert_eq!(score("zzzzz", "crane"), [A, A, A, A, A]);
        // The exact match takes the only e, so the earlier e's are absent.
        assert_eq!(score("eerie", "crane"), [A, A, P, A, C]);
        // Two e's guessed, one in the answer, neither in place: only the first shows.
        assert_eq!(score("speed", "abide"), [A, A, P, A, P]);
        assert_eq!(score("llama", "hello"), [P, P, A, A, A]);
        assert_eq!(score("hello", "llama"), [A, A, P, P, A]);
        assert_eq!(score("sassy", "essay"), [P, P, C, A, C]);
    }

    #[test]
    fn guesses_are_normalized_and_checked() {
        assert_eq!(normalize_guess(" CRANE "), Ok("crane".to_string()));
        assert_eq!(normalize_guess("cran"), Err(GuessError::Shape));
        assert_eq!(normalize_guess("cr4ne"), Err(GuessError::Shape));
        assert_eq!(normalize_guess("crânes"), Err(GuessError::Shape));
        assert_eq!(normalize_guess("qqqqq"), Err(GuessError::NotAWord));
    }

    #[test]
    fn days_and_puzzle_numbers() {
        let day = NaiveDate::from_ymd_opt(2026, 9, 24).unwrap();
        assert_eq!(puzzle_for(first_day()), 1);
        assert_eq!(date_for(puzzle_for(day)), day);
        let now = day.and_hms_opt(23, 59, 59).unwrap().and_utc();
        assert_eq!(puzzle_at(now), puzzle_for(day));
        assert_eq!(
            next_puzzle_at(now),
            NaiveDate::from_ymd_opt(2026, 9, 25)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
        );
    }

    #[test]
    fn a_cycle_uses_every_answer_once_and_depends_on_the_secret() {
        let key = order_key("secret-a");
        let count = answer_count() as i64;
        let cycle: HashSet<&str> = (1..=count).map(|day| answer_for(&key, day)).collect();
        assert_eq!(cycle.len(), answer_count());
        let other = order_key("secret-b");
        let first_week: Vec<_> = (1..=7).map(|day| answer_for(&key, day)).collect();
        let other_week: Vec<_> = (1..=7).map(|day| answer_for(&other, day)).collect();
        assert_ne!(first_week, other_week);
        assert_eq!(answer_for(&key, 3), answer_for(&key, 3));
        let next_cycle: Vec<_> = (count + 1..=count + 7)
            .map(|day| answer_for(&key, day))
            .collect();
        assert_ne!(first_week, next_cycle);
    }

    fn day(puzzle: i64, guess_count: i64, finished: bool, solved: bool) -> DayResult {
        DayResult {
            puzzle,
            guess_count,
            finished,
            solved,
        }
    }

    #[test]
    fn streaks_follow_consecutive_solved_days() {
        let empty = stats(&[], 10);
        assert_eq!(
            (empty.played, empty.current_streak, empty.max_streak),
            (0, 0, 0)
        );

        // Solved 1-3, missed 4, solved 6-9; today (10) not opened yet.
        let results = [
            day(1, 3, true, true),
            day(2, 4, true, true),
            day(3, 2, true, true),
            day(4, 6, true, false),
            day(6, 5, true, true),
            day(7, 1, true, true),
            day(8, 3, true, true),
            day(9, 6, true, true),
        ];
        let summary = stats(&results, 10);
        assert_eq!(summary.played, 8);
        assert_eq!(summary.solved, 7);
        assert_eq!(summary.missed, 1);
        assert_eq!(summary.max_streak, 4);
        assert_eq!(summary.current_streak, 4);
        assert_eq!(summary.distribution, [1, 1, 2, 1, 1, 1]);

        // Two days later with nothing played, the streak is gone; the max stays.
        let later = stats(&results, 11);
        assert_eq!((later.current_streak, later.max_streak), (0, 4));

        // Today in progress keeps yesterday's streak; a miss today ends it.
        let mut with_today = results.to_vec();
        with_today.push(day(10, 2, false, false));
        assert_eq!(stats(&with_today, 10).current_streak, 4);
        assert_eq!(stats(&with_today, 10).played, 8);
        with_today.pop();
        with_today.push(day(10, 6, true, false));
        assert_eq!(stats(&with_today, 10).current_streak, 0);
        with_today.pop();
        with_today.push(day(10, 2, true, true));
        assert_eq!(stats(&with_today, 10).current_streak, 5);
        assert_eq!(stats(&with_today, 10).max_streak, 5);

        // A day started and never finished counts as a miss once it is over.
        let abandoned = [
            day(1, 1, true, true),
            day(2, 3, false, false),
            day(3, 2, true, true),
        ];
        let summary = stats(&abandoned, 4);
        assert_eq!(
            (
                summary.played,
                summary.missed,
                summary.max_streak,
                summary.current_streak
            ),
            (3, 1, 1, 1)
        );
    }
}
