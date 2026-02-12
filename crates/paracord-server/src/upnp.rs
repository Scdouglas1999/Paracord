use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};

/// Result of a successful port-forwarding setup.
pub struct UpnpResult {
    pub external_ip: IpAddr,
    pub server_port: u16,
    pub livekit_port: u16,
    pub method: &'static str,
}

/// Discover the gateway and forward all required ports.
///
/// Tries three methods in order:
///   1. UPnP IGD (most routers)
///   2. NAT-PMP / PCP via crab_nat (Apple, many gaming routers)
///   3. External IP detection only (user must forward ports manually)
pub async fn setup_upnp(
    server_port: u16,
    livekit_port: u16,
    lease_seconds: u32,
) -> anyhow::Result<UpnpResult> {
    // ── Method 1: UPnP IGD ──────────────────────────────────────────────────
    tracing::info!("Attempting UPnP port forwarding...");
    match try_upnp_igd(server_port, livekit_port, lease_seconds).await {
        Ok(result) => return Ok(result),
        Err(e) => tracing::info!("UPnP IGD unavailable: {}", e),
    }

    // ── Method 2: NAT-PMP / PCP ─────────────────────────────────────────────
    tracing::info!("Attempting NAT-PMP/PCP port forwarding...");
    match try_nat_pmp(server_port, livekit_port, lease_seconds).await {
        Ok(result) => return Ok(result),
        Err(e) => tracing::info!("NAT-PMP/PCP unavailable: {}", e),
    }

    // ── Method 3: Just detect external IP ───────────────────────────────────
    tracing::info!("No automatic port forwarding available, detecting external IP...");
    match detect_external_ip().await {
        Ok(ip) => {
            tracing::warn!(
                "Could not auto-forward ports. You may need to manually forward port {} (TCP) in your router to this machine.",
                server_port
            );
            Ok(UpnpResult {
                external_ip: ip,
                server_port,
                livekit_port,
                method: "External IP only (manual port forwarding needed)",
            })
        }
        Err(e) => anyhow::bail!(
            "No port forwarding method available and could not detect external IP: {}",
            e
        ),
    }
}

// ── UPnP IGD ────────────────────────────────────────────────────────────────

async fn try_upnp_igd(
    server_port: u16,
    livekit_port: u16,
    lease_seconds: u32,
) -> anyhow::Result<UpnpResult> {
    let gateway = igd_next::aio::tokio::search_gateway(igd_next::SearchOptions {
        timeout: Some(std::time::Duration::from_secs(8)),
        ..Default::default()
    })
    .await
    .map_err(|e| anyhow::anyhow!("{}", e))?;

    let external_ip = gateway
        .get_external_ip()
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?;

    tracing::info!("UPnP gateway found! External IP: {}", external_ip);

    let local_ip = get_local_ip(gateway.addr)?;

    // Only one port needs forwarding: the server port handles everything.
    // TCP: HTTP API, WebSocket signaling, LiveKit proxy
    // UDP: WebRTC media via LiveKit UDP mux on the same port number
    add_upnp_mapping(
        &gateway, local_ip, server_port, lease_seconds,
        "Paracord Server", igd_next::PortMappingProtocol::TCP,
    ).await;
    add_upnp_mapping(
        &gateway, local_ip, server_port, lease_seconds,
        "Paracord Media UDP", igd_next::PortMappingProtocol::UDP,
    ).await;

    tracing::info!("UPnP port forwarding complete.");

    Ok(UpnpResult {
        external_ip,
        server_port,
        livekit_port,
        method: "UPnP IGD",
    })
}

async fn add_upnp_mapping(
    gateway: &igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>,
    local_ip: IpAddr,
    port: u16,
    lease_seconds: u32,
    description: &str,
    protocol: igd_next::PortMappingProtocol,
) {
    let local_addr = SocketAddr::new(local_ip, port);
    match gateway.add_port(protocol, port, local_addr, lease_seconds, description).await {
        Ok(()) => {
            let proto = match protocol {
                igd_next::PortMappingProtocol::TCP => "TCP",
                igd_next::PortMappingProtocol::UDP => "UDP",
            };
            tracing::info!("  Forwarded {} port {} -> {}:{}", proto, port, local_ip, port);
        }
        Err(igd_next::AddPortError::PortInUse) => {
            tracing::debug!("Port {} already mapped (likely ours)", port);
        }
        Err(e) => {
            tracing::warn!("Failed to forward {} port {}: {}", description, port, e);
        }
    }
}

// ── NAT-PMP / PCP ───────────────────────────────────────────────────────────

async fn try_nat_pmp(
    server_port: u16,
    livekit_port: u16,
    lease_seconds: u32,
) -> anyhow::Result<UpnpResult> {
    let gateway_ip = detect_gateway_ip()?;
    let local_ip = get_local_ip_for(gateway_ip)?;

    let options = crab_nat::PortMappingOptions {
        external_port: None,
        lifetime_seconds: Some(lease_seconds),
        timeout_config: Some(crab_nat::TimeoutConfig {
            initial_timeout: std::time::Duration::from_millis(500),
            max_retries: 5,
            max_retry_timeout: Some(std::time::Duration::from_secs(4)),
        }),
    };

    let gw: IpAddr = gateway_ip.into();
    let client: IpAddr = local_ip.into();

    // Map the server port — this is the one that must succeed
    let _mapping = crab_nat::PortMapping::new(
        gw, client,
        crab_nat::InternetProtocol::Tcp,
        std::num::NonZeroU16::new(server_port).unwrap(),
        options,
    )
    .await
    .map_err(|e| anyhow::anyhow!("NAT-PMP mapping failed: {:?}", e))?;

    tracing::info!("NAT-PMP/PCP: mapped server port {}", server_port);

    // UDP on the server port for WebRTC media (LiveKit UDP mux shares the port)
    let udp_options = crab_nat::PortMappingOptions {
        lifetime_seconds: Some(lease_seconds),
        ..Default::default()
    };
    let _ = crab_nat::PortMapping::new(
        gw, client,
        crab_nat::InternetProtocol::Udp,
        std::num::NonZeroU16::new(server_port).unwrap(),
        udp_options,
    ).await;

    tracing::info!("NAT-PMP/PCP port forwarding complete.");

    // NAT-PMP gives us the gateway IP, not the public IP — fetch the real one
    let public_ip = detect_external_ip()
        .await
        .unwrap_or(IpAddr::V4(gateway_ip));

    Ok(UpnpResult {
        external_ip: public_ip,
        server_port,
        livekit_port,
        method: "NAT-PMP/PCP",
    })
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Detect external/public IP using HTTP APIs.
async fn detect_external_ip() -> anyhow::Result<IpAddr> {
    let services = [
        "https://api.ipify.org",
        "https://checkip.amazonaws.com",
        "https://ifconfig.me/ip",
    ];

    for url in services {
        if let Ok(resp) = reqwest::get(url).await {
            if let Ok(text) = resp.text().await {
                if let Ok(ip) = text.trim().parse::<IpAddr>() {
                    return Ok(ip);
                }
            }
        }
    }

    anyhow::bail!("Could not detect external IP from any service")
}

/// Guess the default gateway by assuming .1 on our local subnet.
fn detect_gateway_ip() -> anyhow::Result<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")?;
    socket.connect("8.8.8.8:53")?;
    if let IpAddr::V4(ip) = socket.local_addr()?.ip() {
        let octets = ip.octets();
        Ok(Ipv4Addr::new(octets[0], octets[1], octets[2], 1))
    } else {
        anyhow::bail!("IPv6 not supported for NAT-PMP gateway detection")
    }
}

/// Detect our local IP by connecting a UDP socket toward the gateway.
fn get_local_ip(gateway_addr: SocketAddr) -> anyhow::Result<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")?;
    socket.connect(gateway_addr)?;
    Ok(socket.local_addr()?.ip())
}

fn get_local_ip_for(gateway: Ipv4Addr) -> anyhow::Result<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")?;
    socket.connect(SocketAddrV4::new(gateway, 1))?;
    match socket.local_addr()?.ip() {
        IpAddr::V4(ip) => Ok(ip),
        _ => anyhow::bail!("Expected IPv4 local address"),
    }
}

/// Forward an additional TCP port via UPnP (e.g. for HTTPS).
pub async fn forward_extra_port(port: u16, lease_seconds: u32) {
    let gateway = match igd_next::aio::tokio::search_gateway(igd_next::SearchOptions {
        timeout: Some(std::time::Duration::from_secs(5)),
        ..Default::default()
    })
    .await
    {
        Ok(gw) => gw,
        Err(e) => {
            tracing::debug!("Could not forward extra port {} via UPnP: {}", port, e);
            return;
        }
    };

    let local_ip = match get_local_ip(gateway.addr) {
        Ok(ip) => ip,
        Err(_) => return,
    };

    add_upnp_mapping(
        &gateway, local_ip, port, lease_seconds,
        "Paracord HTTPS", igd_next::PortMappingProtocol::TCP,
    ).await;
}

/// Remove UPnP port mappings on shutdown.
pub async fn cleanup_upnp(server_port: u16, _livekit_port: u16) {
    let gateway = match igd_next::aio::tokio::search_gateway(igd_next::SearchOptions {
        timeout: Some(std::time::Duration::from_secs(3)),
        ..Default::default()
    })
    .await
    {
        Ok(gw) => gw,
        Err(_) => return,
    };

    let _ = gateway
        .remove_port(igd_next::PortMappingProtocol::TCP, server_port)
        .await;
    let _ = gateway
        .remove_port(igd_next::PortMappingProtocol::UDP, server_port)
        .await;
    tracing::info!("UPnP port mappings removed.");
}

/// Remove a single extra port mapping (e.g. HTTPS) on shutdown.
pub async fn cleanup_extra_port(port: u16) {
    let gateway = match igd_next::aio::tokio::search_gateway(igd_next::SearchOptions {
        timeout: Some(std::time::Duration::from_secs(3)),
        ..Default::default()
    })
    .await
    {
        Ok(gw) => gw,
        Err(_) => return,
    };

    let _ = gateway
        .remove_port(igd_next::PortMappingProtocol::TCP, port)
        .await;
}
