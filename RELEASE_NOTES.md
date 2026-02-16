## What's New in v0.6.0

### PostgreSQL Support (Production-Ready)

Paracord now ships with full PostgreSQL support alongside SQLite. The entire database layer has been rewritten to use `sqlx::Any` for runtime backend selection, with separate migration tracks ensuring correct DDL for each engine.

- **Dual-backend query layer**: All 28 database modules rewritten for cross-database compatibility using positional parameter binding and a custom PL/pgSQL compatibility shim for `datetime()`/`strftime()`
- **PostgreSQL connection tuning**: New `after_connect` hook sets `lock_timeout`, `timezone`, and configurable `statement_timeout` and `idle_in_transaction_session_timeout` per connection
- **New config options**: `statement_timeout_secs` and `idle_in_transaction_timeout_secs` in `[database]`, plus env var overrides
- **Improved error messages**: PostgreSQL connection failures now include actionable hints (check credentials, SSL mode, server availability)
- **27 parallel migrations**: Full schema parity between SQLite and PostgreSQL migration tracks

To switch from SQLite to PostgreSQL:
```toml
[database]
engine = "postgres"
url = "postgresql://user:password@localhost:5432/paracord?sslmode=prefer"
max_connections = 20
statement_timeout_secs = 30
```

### Voice & WebRTC Reliability

- **Connection timeout handling**: LiveKit room connections now have configurable timeouts instead of hanging indefinitely
- **Multi-server voice routing**: Voice connections correctly resolve the LiveKit proxy URL from the active server entry, not just the stored default
- **LiveKit proxy resilience**: WebRTC proxy now tracks connection sequences, gracefully handles mid-stream disconnects, and falls back to direct connections when the proxy is unavailable
- **Heartbeat tracking**: WebSocket connections now track `lastHeartbeatSent`, `missedAcks`, and `connectionLatency` for better disconnect detection
- **Pending message queue**: Messages sent during reconnection are buffered (up to 50) and replayed on reconnect

### Connection Manager Overhaul

- **Deduplication**: Concurrent `connectServer()` calls for the same server are coalesced instead of racing
- **Aggregate status tracking**: Global UI connection indicator now reflects the combined state of all server connections (connected/connecting/reconnecting/disconnected)
- **Stale connection guard**: Reconnection logic checks whether the connection object is still the active one before applying state changes

### Permissions & Caching

- **Targeted cache invalidation**: Channel and user permission invalidation now removes only affected cache entries instead of flushing the entire cache
- **Batch permission computation**: New `compute_all_channel_permissions()` loads roles and overwrites once, then computes permissions for all channels in-memory -- used for channel list rendering

### Federation Hardening

- **Federation service in AppState**: Federation signing and verification are pre-initialized at startup instead of re-parsing environment variables on every request
- **Per-peer rate limiting**: Configurable `max_events_per_peer_per_minute` and `max_user_creates_per_peer_per_hour` for inbound federation traffic
- **Fixed `MIN()` scalar bug**: Federation outbound queue used SQLite-only `MIN(a, b)` scalar function, which would fail on PostgreSQL -- replaced with portable `CASE` expression

### Backup & Restore

- PostgreSQL backup support via `pg_dump`/`pg_restore` alongside existing SQLite `.backup` command
- Improved error handling and progress reporting during backup operations

### Other Improvements

- **Tooltip component rewrite**: More reliable positioning, portal-based rendering, and animation
- **Message list**: Improved scroll anchoring and virtual list behavior
- **Channel store**: Additional metadata tracking for channel state
- **Server settings**: Expanded configuration surface with env var overrides
- **CI release workflow**: Release notes are now read from `RELEASE_NOTES.md` in the repository, preventing CI from overwriting manually authored notes

### Breaking Changes

- `create_pool_with_engine_and_sqlite_key()` still works but now delegates to `create_pool_full()` which accepts an additional `PgConnectOptions` parameter
- `DatabaseConfig` has two new fields (`statement_timeout_secs`, `idle_in_transaction_timeout_secs`) -- both default to 0 (disabled), so existing configs are unaffected
