mod common;

use common::{build_test_app, TestAppOptions};

#[tokio::test]
async fn concurrent_poll_voters_and_single_select_replacements_are_atomic() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions {
        database_connections: 8,
        ..Default::default()
    })
    .await?;
    let pool = &app.db;
    for user in 101..109 {
        paracord_db::users::create_user(
            pool,
            user,
            &format!("voter{user}"),
            1,
            &format!("voter{user}@example.test"),
            "fixture",
        )
        .await?;
    }
    paracord_db::guilds::create_guild(pool, 201, "Concurrent voters", 101, None).await?;
    paracord_db::channels::create_channel(pool, 301, 201, "polls", 0, 0, None, None).await?;
    paracord_db::messages::create_message(pool, 401, 301, 101, "Ballot", 20, None).await?;
    paracord_db::polls::create_poll(
        pool,
        501,
        401,
        301,
        "Choose one",
        &[
            paracord_db::polls::CreatePollOption {
                text: "First".into(),
                emoji: None,
            },
            paracord_db::polls::CreatePollOption {
                text: "Second".into(),
                emoji: None,
            },
        ],
        false,
        None,
    )
    .await?;
    let ballot = paracord_db::polls::get_poll(pool, 501, 101)
        .await?
        .expect("created poll");
    let options = [ballot.options[0].id, ballot.options[1].id];

    // Separate pooled connections reproduce the SQLite read-to-write upgrade
    // failure; the usual single-connection in-memory fixture cannot expose it.
    let votes = futures_util::future::join_all(
        (101..109).map(|user| paracord_db::polls::add_vote(pool, 501, options[0], user)),
    )
    .await;
    for vote in votes {
        vote?;
    }

    // Repeated overlapping replacements must leave exactly one choice for the
    // same user on both engines, while preserving every other account's vote.
    for _ in 0..4 {
        let replacements = futures_util::future::join_all(
            (0..16).map(|i| paracord_db::polls::add_vote(pool, 501, options[i % 2], 101)),
        )
        .await;
        for replacement in replacements {
            replacement?;
        }
        let ballot = paracord_db::polls::get_poll(pool, 501, 101)
            .await?
            .expect("poll remains");
        assert_eq!(ballot.total_votes, 8, "single-select vote count changed");
        assert_eq!(ballot.options.iter().filter(|o| o.voted).count(), 1);
    }

    // The same serialization must preserve the distinct multi-select contract,
    // including the true Boolean parameter on PostgreSQL's legacy integer flag.
    paracord_db::messages::create_message(pool, 402, 301, 101, "Multiple choices", 20, None)
        .await?;
    paracord_db::polls::create_poll(
        pool,
        502,
        402,
        301,
        "Choose several",
        &[
            paracord_db::polls::CreatePollOption {
                text: "First".into(),
                emoji: None,
            },
            paracord_db::polls::CreatePollOption {
                text: "Second".into(),
                emoji: None,
            },
        ],
        true,
        None,
    )
    .await?;
    let ballot = paracord_db::polls::get_poll(pool, 502, 101)
        .await?
        .expect("created multiselect poll");
    assert!(ballot.poll.allow_multiselect);
    let votes = futures_util::future::join_all(
        ballot
            .options
            .iter()
            .map(|option| paracord_db::polls::add_vote(pool, 502, option.id, 101)),
    )
    .await;
    for vote in votes {
        vote?;
    }
    let ballot = paracord_db::polls::get_poll(pool, 502, 101)
        .await?
        .expect("multiselect poll remains");
    assert_eq!(ballot.total_votes, 2);
    assert!(ballot.options.iter().all(|option| option.voted));
    Ok(())
}
