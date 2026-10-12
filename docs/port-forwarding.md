# Letting friends outside your network join

Your Paracord server runs on your computer. People on the same Wi-Fi can reach it
straight away. People anywhere else cannot, not because anything is broken, but
because your router does not yet know that traffic arriving from the internet
should be handed to your computer.

Paracord asks your router to do that for you (UPnP, NAT-PMP and PCP are the three
ways a router can agree). It is on by default. This page says what Paracord tells
you about the answer, what each answer means, and what to do when the router says
no.

Paracord never asks a website what your address is. The only things it believes
are what your router answers and who actually connects, so everything you read
below comes from your own network.

---

## What the app tells you

The app shows one of these in the server's settings and in the setup list when the
server starts. The first line of each row is what you will see.

| You see | What it means | What to do |
| --- | --- | --- |
| **Your router opened the way. Friends can reach you at {address}.** | The router accepted the request and reported a public address. | Nothing. Share an invite. |
| **A friend connected from outside {time}.** | Someone really did connect from the internet. This is the only proof that the whole path works. | Nothing. |
| **This computer has its own public address ({address}). Friends can reach it if your firewall allows port {port}.** | There is no router in front of this computer. | Make sure your firewall allows the port ([Step 5](#step-5-let-your-own-firewall-through-as-well)). |
| **Your router didn't allow it, so for now only people on your home network can join.** | A router answered and refused. Many routers ship with this feature off. | Turn it on in the router, or forward the port yourself (below). Paracord checks again every minute, so you do not need to restart. |
| **Your router didn't answer, so for now only people on your home network can join.** | Nothing on your network replied to any of the three requests. The router either does not support them or has them off. | Same as above. |
| **Your internet connection shares its public address with others...** | The router did accept, but the address it reports is not a public one (it starts with `10.`, `172.16`-`172.31`, `192.168.`, `100.64`-`100.127` or `169.254.`). Either your provider shares one address between customers, or another router sits in front of yours. | See [Two routers or a shared address](#two-routers-or-a-shared-address). |
| **Windows Firewall is blocking friends.** | Windows only. The firewall rule for Paracord is missing, usually because the permission box was declined. | Press **Allow** next to it, or see Step 5. |
| **Paracord isn't asking your router to let friends in.** | The setting is off. | Turn it on (below), or forward the port yourself. |

While the router is refusing, not answering or shares its address, Paracord asks
again every minute. When the answer changes, the text above changes with it, and
the address in the invite links changes too.

**Your public address can change.** Most home internet providers change it now and
then. Invite links made earlier then stop working. Paracord tells you ("Your public
address changed. Links you shared before won't work; share this one.") and the
invite screen always shows the current link. There is no dynamic-DNS service
built in, because that would need an outside service to know your address. If you
want a link that never changes, give the server a domain name
([deployment guide](deployment.md#a-domain-name-and-automatic-certificates)).

## Turning the automatic request on or off

It is one setting, **Let friends outside your home network connect**, in the
server's settings in the app. Restart the server after changing it. The
installers ask once, and the default is yes. To change it in the settings file:

```toml
[network]
auto_port_forward = true   # or false
```

`PARACORD_AUTO_PORT_FORWARD=true|false` overrides the file; while it is set, the
app shows the setting but cannot change it. A server that has it on will ask the
router on every start and renew the request while it runs. When Paracord stops it
removes what it asked for.

If the router does not allow it, or you would rather nothing change your router's
settings for you, set it up on the router yourself. It takes about five minutes
and you only do it once.

---

## What you need before you start

1. **The port number.** Under the normal settings this is **8443**, and you open
   it for both **TCP** and **UDP**. (TCP carries the app; UDP carries voice,
   video and screen share. Opening only one leaves calls silent.) If you changed
   `bind_address` or `[voice] port` in your config, the server's settings page and
   its startup message name the exact numbers; use those.
2. **This computer's address on your own network.** Something like
   `192.168.1.5`. The server's settings page and its startup message show it; you
   can also find it with:
   - **Windows:** `ipconfig`, then "IPv4 Address"
   - **macOS:** System Settings, Network, your connection, Details
   - **Linux:** `ip -4 addr`, then the address on your normal network interface
3. **Your router's address.** Usually `192.168.1.1` or `192.168.0.1`. Find it
   with:
   - **Windows:** `ipconfig`, then "Default Gateway"
   - **macOS:** System Settings, Network, Details, TCP/IP, Router
   - **Linux:** `ip route | grep default`

---

## Step 1: give this computer a fixed local address

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

## Step 2: open your router's settings page

Type your router's address into a browser, for example `http://192.168.1.1`, and
sign in. The username and password are often printed on a sticker on the router
itself. If you have never changed them and they are still the printed defaults,
change them now; anyone on your network can otherwise reconfigure it.

While you are there, check whether the router has a **UPnP** or **NAT-PMP**
switch (often under Advanced, NAT or Firewall). Turning it on lets Paracord do the
rest by itself, and you can skip the steps below.

## Step 3: find the port forwarding screen

Every router calls this something slightly different. Look for:

- **Port Forwarding**
- **Virtual Server** / **Virtual Servers**
- **NAT**, then **Port Mapping** or **Port Forwarding**
- **Applications and Gaming** (older Linksys)
- **Firewall**, then **Port Forwards**

It is usually under an "Advanced", "WAN" or "Security" section. If you cannot
find it, search the web for your router's model name plus "port forwarding";
manufacturers publish screenshots.

## Step 4: create the rule

Add a rule (some routers make you add two: one per protocol) with these values:

| Field on your router | What to enter |
| --- | --- |
| Name / Description / Service | `Paracord` |
| Protocol | `TCP/UDP`, or, if you must pick one, make **two** rules: one TCP, one UDP |
| External / Public / WAN port | `8443` |
| Internal / Private / LAN port | `8443`, the same number |
| Internal IP / Device / To address | this computer's local address, e.g. `192.168.1.5` |
| Enabled | yes |

Keep the external and internal port numbers the same. Paracord tells people one
address, and clients work out where to send voice and video from that same
number; a different outside port breaks calls.

Save, and apply or reboot if the router asks you to.

## Step 5: let your own firewall through as well

The router is only the first door. Your computer has one too.

- **Windows:** the installer and the desktop app add their own allow rules. If
  they are missing, Windows Defender Firewall, Advanced settings, Inbound Rules,
  New Rule, Port, TCP `8443`, then repeat for UDP.
- **macOS:** System Settings, Network, Firewall, Options, allow incoming
  connections for `paracord-server`.
- **Linux:** with `ufw`, `sudo ufw allow 8443/tcp && sudo ufw allow 8443/udp`;
  with `firewalld`,
  `sudo firewall-cmd --permanent --add-port=8443/tcp --add-port=8443/udp && sudo firewall-cmd --reload`.

---

## Step 6: check it worked

**The server has to be running** for any of these checks to pass.

1. **Read the address from your own router.** Its status page (often called
   Status, Internet or WAN) shows the address your provider gave it, something like
   `203.0.113.9`. That is your public address. If it starts with `10.`, `192.168.`,
   `172.16` to `172.31` or `100.64` to `100.127`, it is not public; read
   [Two routers or a shared address](#two-routers-or-a-shared-address).
2. **Open the real thing from somewhere else.** On a phone with Wi-Fi turned
   **off**, visit `https://<your public address>:8443`, for example
   `https://203.0.113.9:8443`. You should see Paracord's sign-in page. Testing from
   a browser on your own network usually proves nothing: many routers answer local
   requests without ever using the rule.
3. **Send an invite and have a friend join.** When someone connects from outside,
   the app says so ("A friend connected from outside"). That is the proof.
4. **Make a call.** Voice and video use UDP, and UDP is the part people forget.
   Join a voice channel from that phone and say something. If the page loads but
   calls are silent, the UDP half of the rule is missing or wrong.

---

## If it still does not work

### Two routers or a shared address

Both of these end the same way: the address your router reports is not one the
internet can reach.

- **Two routers.** If your internet provider's box feeds a second router of your
  own, traffic has to pass through both. Make the same rule on each, or put one
  of them in "bridge mode". The sign: the address on your router's WAN or Internet
  page starts with `192.168.`, `10.` or `172.16` to `172.31`.
- **Your provider does not give you a public address.** Some mobile and fiber
  providers put every customer behind one shared address (CGNAT). No amount of
  port forwarding helps, because the address is not yours. The sign: the WAN
  address starts with `100.64` to `100.127`. Ask your provider for a public IPv4
  address (some give one free, some charge a little), or run Paracord on a rented
  server instead.

### Other causes

- **The port is already taken.** If another program on this computer is using
  8443, Paracord says so when it starts. Pick a different number in your config,
  for both the app and `[voice] port`, and use that number everywhere above.
- **The browser warns about the certificate.** That is expected: a fresh server
  makes its own certificate. Choose **Advanced**, then **Continue**. The desktop
  app does not show this warning. To get rid of it entirely, point a domain name
  at your address and turn on automatic certificates (`[tls] acme`).

## Is it safe to be reachable?

Being reachable is the point; friends cannot join a server they cannot connect
to. Two things protect a brand-new server:

- Until you finish setting it up, **nobody can create an account**, including
  anyone who finds the address before you do. That is what the one-time link the
  server prints is for.
- After that, people join the way you let them. A new server is **invite-only**:
  an account can only be made with an invite link to one of your servers
  (`[auth] registration_mode = "invite_only"`, or **Admin, Settings, Who can
  create an account**). You can open it to anyone, or turn new accounts off
  entirely.
