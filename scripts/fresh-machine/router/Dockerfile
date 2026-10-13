# The simulated home router: NAT between a "lan" and a "wan" network, with
# miniupnpd answering UPnP IGD and NAT-PMP/PCP on the lan side.
#
# miniupnpd is built from source with its nftables backend: Arch's package
# uses libiptc (legacy iptables), which needs the legacy ip_tables kernel
# modules, and the harness never loads modules on the machine it runs on.
FROM archlinux:latest AS build
RUN pacman -Syu --noconfirm --needed base-devel libnftnl libmnl util-linux-libs libcap-ng curl python
ARG MINIUPNPD_TAG=miniupnpd_2_3_9
RUN curl -fsSL "https://github.com/miniupnp/miniupnp/archive/refs/tags/${MINIUPNPD_TAG}.tar.gz" -o /tmp/m.tgz \
 && mkdir -p /src && tar -xzf /tmp/m.tgz -C /src --strip-components=1
COPY lab-patch.py /src/miniupnpd/lab-patch.py
RUN cd /src/miniupnpd && python3 lab-patch.py
RUN cd /src/miniupnpd && ./configure --firewall=nftables --portinuse --leasefile \
 && make -j"$(nproc)" \
 && install -Dm0755 miniupnpd /out/miniupnpd \
 && cp -r netfilter_nft/scripts /out/nft-scripts

FROM archlinux:latest
RUN pacman -Syu --noconfirm --needed nftables libnftnl libmnl util-linux-libs libcap-ng iproute2 conntrack-tools tcpdump procps-ng which \
 && pacman -Scc --noconfirm
COPY --from=build /out/miniupnpd /usr/bin/miniupnpd
COPY --from=build /out/nft-scripts /etc/miniupnpd/nft-scripts
COPY router-start.sh /usr/local/bin/router-start
COPY router-ctl.sh /usr/local/bin/router-ctl
RUN chmod 0755 /usr/local/bin/router-start /usr/local/bin/router-ctl
ENTRYPOINT ["/usr/local/bin/router-start"]
