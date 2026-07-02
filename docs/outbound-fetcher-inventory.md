# Outbound Fetcher Inventory

Release-candidate review date: 2026-05-17.

This inventory separates user/peer-controlled outbound fetches, which need SSRF
defenses, from fixed or operator-configured service integrations.

## User Or Peer Controlled URLs

| Fetcher | Source | Protection |
| --- | --- | --- |
| OpenGraph link previews | Message content URLs in `crates/paracord-api/src/opengraph.rs` | Allows only HTTP/HTTPS, resolves DNS before each request, blocks localhost, metadata hosts/aliases, `.local`, `home.arpa`, private/reserved/documentation/multicast IPv4 ranges, IPv6 loopback/link-local/unique-local/documentation/multicast/unspecified, IPv4-mapped private addresses, disables automatic redirects, revalidates up to three manual redirects, and stops reading responses at the 512 KiB parse cap. |
| Federation peer RPCs | Trusted federation endpoints used by `crates/paracord-federation/src/client.rs` for server info, keys, events, invites, joins, media, and file-token RPCs | Validates the target URL and DNS with `validate_public_federation_url_with_dns` before each request, blocks private/reserved hosts unless explicitly allowed for local validation, and uses an SSRF-checked HTTP client with automatic redirects disabled so redirects cannot bypass validation. |
| Federation file downloads | Remote federation file URL in `crates/paracord-federation/src/client.rs` | Allows only HTTPS on standard ports, blocks private/reserved IPs and metadata hosts, resolves DNS before request, follows redirects manually so every redirect target is revalidated with DNS/private-network checks before the next request, and caps redirect count. |
| Federated discovery peers | Trusted federation endpoint in `crates/paracord-api/src/routes/discovery.rs` | Reuses `validate_public_federation_url_with_dns` before fetching each peer discovery URL, uses the same no-automatic-redirect HTTP client so redirected private/internal targets are not followed, and caps streamed peer discovery JSON responses at 512 KiB. |
| Federation moderation subscriptions | Configured moderation-list source URL in `crates/paracord-api/src/routes/federation.rs` | Revalidates `source_url` with `validate_public_federation_url_with_dns` at fetch time, so older stored subscriptions cannot continue targeting private infrastructure after validation rules change, and uses the same no-automatic-redirect HTTP client. |

## Fixed Vendor Endpoints

| Fetcher | Source | Boundary |
| --- | --- | --- |
| Tenor GIF search/trending | `crates/paracord-api/src/routes/tenor.rs` | Calls fixed `https://tenor.googleapis.com/v2/search` and `https://tenor.googleapis.com/v2/featured` with a 5-second client timeout, automatic redirects disabled, and a 1 MiB streamed response-body cap; users control query parameters, not the host. Upstream request failures log sanitized messages without full request URLs or upstream response bodies, avoiding accidental API-key leakage. |
| Public IP detection | `crates/paracord-server/src/main.rs` | Calls fixed `https://api.ipify.org` with a 3-second client timeout, automatic redirects disabled, a 128-byte response-body cap, and IP-address syntax validation only when binding publicly and no explicit public IP is configured. |

## Operator-Configured Integrations

| Fetcher | Source | Boundary |
| --- | --- | --- |
| LiveKit admin/proxy calls | `crates/paracord-media/src/livekit.rs`, `crates/paracord-api/src/routes/livekit_proxy.rs` | Uses administrator-configured LiveKit URLs. This is trusted deployment configuration, not user-provided content. LiveKit admin and HTTP proxy clients use explicit 10-second timeouts and disable automatic redirects; client-build failures are surfaced instead of silently falling back to default network behavior. LiveKit admin response bodies that Paracord reads are capped at 64 KiB while streaming. The HTTP proxy caps inbound proxy request bodies at 10 MiB, rejects declared oversized upstream responses, enforces the 1 MiB upstream response cap while streaming bodies without `Content-Length`, and only proxies the LiveKit validation path allowed by the route gate. |
| S3-compatible object storage | `crates/paracord-media/src/s3.rs` | Optional object-storage backend, disabled by default and only active with the `s3` feature plus `storage_type = "s3"`. Endpoint and explicit credentials are administrator configuration. AWS SDK credential-chain discovery is disabled unless the admin sets `use_aws_credential_chain = true`. |
| AI providers | `crates/paracord-api/src/ai.rs` | Disabled unless an administrator configures an AI provider/base URL. Defaults are fixed vendor/local provider URLs. `openai_compatible` and custom base URLs are treated as trusted operator configuration, but must still be absolute HTTP(S) URLs without embedded credentials. AI requests use the configured bounded timeout, disable automatic redirects, and enforce a 1 MiB response-body cap while streaming provider JSON. |

## Release Conclusion

The user/peer-controlled fetchers currently have private-network blocking, DNS
validation, and redirect behavior that either fails closed or revalidates each
hop before following. Operator-configured integrations can intentionally point
at private infrastructure and should be reviewed as part of deployment
configuration, not as user-controllable SSRF surfaces.
