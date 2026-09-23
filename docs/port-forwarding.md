# Letting friends outside your network join

Your Paracord server runs on your computer. People on the same Wi-Fi can reach it
straight away. People anywhere else cannot — not because anything is broken, but
because your router does not yet know that traffic arriving from the internet
should be handed to your computer.

There are two ways to change that:

- **Let Paracord ask your router.** The installer asks whether it should, and
  the answer is no unless you say yes. You can turn it on later in the app under
  **Admin → Settings → Let friends outside your home network connect**, then
  restart the server. When it works, the startup message says **"Friends anywhere
  can join at ..."** and there is nothing on this page you need to do.
- **Set it up on the router yourself**, which is what the rest of this page walks
  through. It takes about five minutes and you only do it once. Do this if your
  router refuses Paracord's request, or if you would rather nothing change your
  router's settings for you.

---

## What you need before you start

Paracord printed all three of these when it started:

1. **The port number.** Under the normal settings this is **8443**, and you open
   it for both **TCP** and **UDP**. (TCP carries the app; UDP carries voice,
   video and screen share. Opening only one leaves calls silent.) If you changed
   `bind_address` or `[voice] port` in your config, the startup message names the
   exact numbers — use those.
2. **This computer's address on your own network.** Something like
   `192.168.1.5`. It appears in the startup message; you can also find it with:
   - **Windows:** `ipconfig` → "IPv4 Address"
   - **macOS:** System Settings → Network → your connection → Details
   - **Linux:** `ip -4 addr` → the address on your normal network interface
3. **Your router's address.** Usually `192.168.1.1` or `192.168.0.1`. Find it
   with:
   - **Windows:** `ipconfig` → "Default Gateway"
   - **macOS:** System Settings → Network → Details → TCP/IP → Router
   - **Linux:** `ip route | grep default`

---

## Step 1 — give this computer a fixed local address

Routers hand out local addresses on a lease. If your computer's address changes,
the rule you are about to create will point at the wrong machine and friends will
stop being able to join.

Two ways to prevent that; either is fine:

- **In the router** (recommended, and usually easier): look for **DHCP
  reservation**, **Static lease** or **Address reservation**, find this computer
  in the list and tie it to the address it already has.
- **On this computer:** set a static IP in your operating system's network
  settings, using the same address, the same router address, and the same subnet
  mask your computer is already using.

## Step 2 — open your router's settings page

Type your router's address into a browser, for example `http://192.168.1.1`, and
sign in. The username and password are often printed on a sticker on the router
itself. If you have never changed them and they are still the printed defaults,
change them now — anyone on your network can otherwise reconfigure it.

## Step 3 — find the port forwarding screen

Every router calls this something slightly different. Look for:

- **Port Forwarding**
- **Virtual Server** / **Virtual Servers**
- **NAT** → **Port Mapping** or **Port Forwarding**
- **Applications and Gaming** (older Linksys)
- **Firewall** → **Port Forwards**

It is usually under an "Advanced", "WAN" or "Security" section. If you cannot
find it, search the web for your router's model name plus "port forwarding" —
manufacturers publish screenshots.

## Step 4 — create the rule

Add a rule (some routers make you add two: one per protocol) with these values:

| Field on your router | What to enter |
| --- | --- |
| Name / Description / Service | `Paracord` |
| Protocol | `TCP/UDP` — or, if you must pick one, make **two** rules: one TCP, one UDP |
| External / Public / WAN port | `8443` |
| Internal / Private / LAN port | `8443` — the same number |
| Internal IP / Device / To address | this computer's local address, e.g. `192.168.1.5` |
| Enabled | yes |

Keep the external and internal port numbers the same. Paracord tells people one
address, and clients work out where to send voice and video from that same
number; a different outside port breaks calls.

Save, and apply or reboot if the router asks you to.

## Step 5 — let your own firewall through as well

The router is only the first door. Your computer has one too.

- **Windows:** Paracord adds its own allow rules when
  `[network] windows_firewall_auto_allow = true`. Otherwise: Windows Defender
  Firewall → Advanced settings → Inbound Rules → New Rule → Port → TCP `8443`,
  then repeat for UDP.
- **macOS:** System Settings → Network → Firewall → Options → allow incoming
  connections for `paracord-server`.
- **Linux:** with `ufw`, `sudo ufw allow 8443/tcp && sudo ufw allow 8443/udp`;
  with `firewalld`,
  `sudo firewall-cmd --permanent --add-port=8443/tcp --add-port=8443/udp && sudo firewall-cmd --reload`.

---

## Step 6 — check it worked

**The server has to be running** for any of these checks to pass.

1. **Find your public address.** Open <https://ifconfig.me> on this computer, or
   read it from Paracord's startup message. It looks like `203.0.113.9`.
2. **Test the TCP port from outside your network.** Open
   <https://www.yougetsignal.com/tools/open-ports/> or
   <https://portchecker.co/> and check port `8443`. It should say **open**.
   Testing it from a browser on your own network usually does *not* prove
   anything: many routers answer local requests without ever using the rule.
3. **Open the real thing from somewhere else.** On a phone with Wi-Fi turned
   **off**, visit `https://<your public address>:8443` — for example
   `https://203.0.113.9:8443`. You should see Paracord's sign-in page.
4. **Make a call.** Voice and video use UDP, and UDP is the part people forget.
   Join a voice channel from that phone and say something. If the page loads but
   calls are silent, the UDP half of the rule is missing or wrong.

---

## If it still does not work

- **Two routers.** If your internet provider's box feeds a second router of your
  own, traffic has to pass through both, and you need the same rule on each (or
  put one of them in "bridge mode"). Two signs of this: the address on your
  router's WAN/Internet page starts with `192.168.`, `10.` or `172.`, or it does
  not match what <https://ifconfig.me> reports.
- **Your provider does not give you a public address.** Some mobile and fibre
  providers put every customer behind a shared address (called CGNAT). No amount
  of port forwarding helps, because the address is not yours. Tell-tale sign: the
  WAN address on your router starts with `100.64.`–`100.127.`, or simply does not
  match <https://ifconfig.me>. Ask your provider for a public IP address (some
  give one free, some charge a little), or run Paracord on a rented server
  instead.
- **The port is already taken.** If another program on this computer is using
  8443, Paracord says so when it starts. Pick a different number in your config —
  for both the app and `[voice] port` — and use that number everywhere above.
- **The browser warns about the certificate.** That is expected: a fresh server
  makes its own certificate. Choose **Advanced**, then **Continue**. The desktop
  app does not show this warning. To get rid of it entirely, point a domain name
  at your address and turn on automatic certificates (`[tls] acme`).

## Asking the router automatically, or not

Whether Paracord asks your router (UPnP, then NAT-PMP) is one setting. New
installs leave it off unless you answered yes to the installer's question. To
change it, use **Admin → Settings → Let friends outside your home network
connect** in the app and restart the server, or edit the settings file:

```toml
[network]
auto_port_forward = true   # or false
```

`PARACORD_AUTO_PORT_FORWARD=true|false` overrides the file; while it is set, the
admin page shows the setting but cannot change it. When the setting is on,
Paracord asks on every start and renews the request while it runs. When it is
off, the startup message says so plainly instead of pretending it tried.
An install that already had it on keeps it on after upgrading.

## Is it safe to be reachable?

Being reachable is the point — friends cannot join a server they cannot connect
to. Two things protect a brand-new server:

- Until you finish setting it up, **nobody can create an account**, including
  anyone who finds the address before you do. That is what the one-time link the
  server prints is for.
- After that, people join the way you let them. A new server is **invite-only**:
  an account can only be made with an invite link to one of your servers
  (`[auth] registration_mode = "invite_only"`, or **Admin → Settings → Who can
  create an account**). You can open it to anyone, or turn new accounts off
  entirely.
