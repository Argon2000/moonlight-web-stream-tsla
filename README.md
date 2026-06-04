
# Moonlight Web Tesla
An unofficial [Moonlight Client](https://moonlight-stream.org/) allowing you to stream your pc to the Web.
This specific fork focuses on optimizing running in a Tesla browser. Plenty of targeted fixes for audio/video and input (controllers) has been done.
It hosts Web Server which will forward [Sunshine](https://docs.lizardbyte.dev/projects/sunshine/latest/) traffic to a Browser using the [WebRTC Api](https://webrtc.org/).

![An image displaying: PC with sunshine and moonlight web installed, a browser making requests to it](/readme/structure.png)

## Live demo in Tesla
https://youtu.be/whdvHChCQbg?si=WLcgPDclkdr8n41i

## Overview

- [Images](#images)
- [Limitations](#limitations)
- [Installation](#installation)
  - [Windows (Easy Setup)](#windows-easy-setup)
  - [Manual Setup](#manual-setup)
- [Setup](#setup)
  - [Streaming to a Tesla Browser](#streaming-to-a-tesla-browser)
    - [Getting a free domain name](#getting-a-free-domain-name)
  - [Troubleshooting](#troubleshooting)
  - [Streaming over the Internet](#streaming-over-the-internet)
  - [Configuring HTTPS](#configuring-https)
    - [Let's Encrypt (recommended)](#option-a-lets-encrypt-recommended-for-tesla--public-access)
    - [Self-signed certificate](#option-b-self-signed-certificate)
  - [Proxying via Apache 2](#proxying-via-apache-2)
- [Config](#config)
  - [Credentials](#credentials)
  - [Two-Factor Authentication (2FA)](#two-factor-authentication-2fa)
  - [Bind Address](#bind-address)
- [Contributors](#contributors)
- [Building](#building)

## Images

### Host List
![View: Hosts](/readme/hostView.jpg)

### Games List
![View: Games View](/readme/gamesView.jpg)

### Streaming
![View: Streaming, sidebar closed](/readme/stream.jpg)
![View: Streaming, sidebar opened](/readme/streamExtended.jpg)

## Limitations
- Features that only work in a [Secure Context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts#:~:text=They%20must%20be,be%20considered%20deprecated.) -> [How to configure a Secure Context / https](#configuring-https)
  - Keyboard Lock (allows to capture almost all keys also OS Keys): [Experimental Keyboard Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Keyboard_API)
- Controllers (USB/Bluetooth gamepads): work over HTTP via the [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API) — no HTTPS required

## Installation

1. Install [Sunshine](http://github.com/LizardByte/Sunshine/releases/tag/v2026.516.143833)

2. Download the [compressed archive](https://www.patreon.com/posts/windows-linux-158842535) for your platform and extract it

### Windows (Easy Setup)

The included `setup.ps1` wizard handles everything interactively:
- Detects your network configuration
- Sets a password for the web interface
- Configures port forwarding via UPnP
- Adds Windows Firewall rules
- Optionally obtains a free Let's Encrypt HTTPS certificate
- Creates a scheduled task for automatic certificate renewal
- Starts the server

**Run as Administrator** (required for firewall rules and UPnP):

```powershell
# Right-click PowerShell → "Run as administrator", then:
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup.ps1
```

Or simply right-click `setup.ps1` → **Run with PowerShell** (it will self-elevate).

Follow the prompts. The wizard will guide you through each step and explain what it is doing.

> **HTTPS / Tesla access:** Choose option 1 (Let's Encrypt) in the certificate step. You need a domain name first — see [Getting a free domain name](#getting-a-free-domain-name).

### Manual Setup

1. Run the `web-server` executable

2. Change your [access credentials](#credentials) in the generated `server/config.json` (requires restart)

3. Go to `http://localhost:43780` and view the web interface

## Setup

Add your PC:

1. Add a new PC (<img src="moonlight-web/web-server/web/resources/ic_add_to_queue_white_48px.svg" alt="icon" style="height:1em; vertical-align:middle;">) with the address `localhost` and leave the port empty (if you're using the default port)

2. Pair your PC by clicking on the host (<img src="moonlight-web/web-server/web/resources/desktop_windows-48px.svg" alt="icon" style="height:1em; vertical-align:middle;">) and entering the code in Sunshine

3. Launch an app

### Streaming to a Tesla Browser

The Tesla browser enforces strict security policies. Accessing Moonlight Web via a local IP address (e.g. `192.168.1.x`) will typically result in an **Access Denied** error. **You must access it via a proper domain name** — the Tesla browser blocks all requests to raw IP addresses and local network ranges.

**Requirements for Tesla:**
1. A **domain name** pointing to your public IP (see [Getting a free domain name](#getting-a-free-domain-name) below)
2. Port forwarding configured on your router
3. (Recommended) An HTTPS certificate for the domain — see [Configuring https](#configuring-https)

#### Getting a free domain name

You need a domain name that resolves to your home public IP. Here are free options:

| Service | Domain Format | Notes |
|---------|---------------|-------|
| **ASUS Router DDNS** | `yourname.asuscomm.com` | Built into ASUS routers, auto-updates IP |
| [DuckDNS](https://www.duckdns.org/) | `yourname.duckdns.org` | Free, simple, supports auto-update scripts |
| [No-IP](https://www.noip.com/) | `yourname.ddns.net` | Free tier (confirm monthly) |
| [Cloudflare](https://www.cloudflare.com/) | Your own domain | Free DNS management, buy domain elsewhere (~$10/yr) |
| [Afraid.org FreeDNS](https://freedns.afraid.org/) | Various subdomains | Free, many domain options |

> **Tip:** Most routers have a built-in DDNS client. Check your router admin panel under WAN → DDNS. This keeps the DNS record updated automatically when your public IP changes.

Check your current public IP at [whatismyip.com](https://www.whatismyip.com/). Your DNS record must point to this IP.

**Required ports to open (in your router/firewall):**

| Port | Protocol | Purpose |
|------|----------|---------|
| 43780 | TCP | Web interface (or whichever port you configured) |
| 40000–40100 | UDP | WebRTC media stream |

> **Windows Firewall:** On some systems you may need to add inbound rules for UDP 40000–40100. Try temporarily disabling Windows Firewall to test if it's blocking traffic. If that helps, add the rules and re-enable it. Also make sure your network profile is set to **Private**.

**Steps to get it working from the Tesla browser:**

1. **Set up your domain** — follow [Getting a free domain name](#getting-a-free-domain-name) above if you don't already have one.

2. **Set your public IP in the config** (`server/config.json`):
   ```json
   {
     "webrtc_nat_1to1": {
       "ice_candidate_type": "srflx",
       "ips": [
         "12.34.56.78"
       ]
     }
   }
   ```
   Replace `12.34.56.78` with your actual public IP (only digits and dots, no `<` or `>`).

3. **Forward ports in your router:**
   - TCP 43780 → your PC's local IP (e.g. `192.168.1.50`)
   - UDP 40000–40100 → your PC's local IP

   > **Tip:** The `setup.ps1` wizard can do this automatically via UPnP.

4. **Use the Cloudflare / Google STUN server** and `udp4` only (already in the default config):
   ```json
   {
     "webrtc_ice_servers": [
       { "urls": ["stun:stun.cloudflare.com:3478"] }
     ],
     "webrtc_network_types": ["udp4"]
   }
   ```

5. Access the web interface from your Tesla browser via `https://yourdomain.com:43780` — or on port 443 if you forwarded that.

> **Note:** Some routers let you export a signed certificate directly. See [Configuring https](#configuring-https).

### Troubleshooting

**Stream connects on PC/phone (local Wi-Fi) but not over cellular or in the Tesla browser:**
- The most common cause is a missing or wrong public IP in `webrtc_nat_1to1`. Double-check it matches [whatismyip.com](https://www.whatismyip.com/).
- Make sure UDP 40000–40100 is forwarded in your router to your PC.
- Try temporarily disabling Windows Firewall to isolate whether it is blocking UDP.

**Tesla browser shows "Access Denied":**
- You are likely trying to access via a local IP address. The Tesla browser blocks local addresses. Use a domain name with a proper DNS record pointing to your public IP.
- Make sure your Tesla is on the same Wi-Fi or using cellular, and that the domain resolves to your router's public IP.

**Audio is not playing after stream starts:**
- This is a browser autoplay restriction. **Tap or click anywhere inside the stream** after it starts — this triggers the AudioContext to resume.
- Make sure audio is actually playing on the host PC (not muted).
- Turn up the volume in the Tesla.
- If using [Apollo](https://github.com/ClassicOldSong/Apollo) instead of Sunshine, try switching to [Sunshine](https://github.com/LizardByte/Sunshine). Apollo has been observed to have performance issues with this client.
- In Sunshine audio settings: leave **Audio sink** and **Virtual sink** empty (auto), and ensure both audio checkboxes are checked.
- When streaming is active, check the Windows Volume Mixer — you should see "Steam Streaming Speakers" with an active level meter (audio is captured but not played locally).

**The `.exe` won't start after editing config:**
- The config is JSON — check for missing or extra commas, especially after the last item in a block.
- Make sure `webrtc_nat_1to1.ips` contains plain IP addresses like `"12.34.56.78"` with no `<` or `>` brackets.

### Streaming over the Internet

1. Set the [bind address](#bind-address) to your network interface and forward the web server port

```json
{
    "bind_address": "192.168.1.100:43780"
}
```

When in a local network the WebRTC Peers will negotatiate without any problems.
When you want to play to over the Internet the STUN servers included by default will try to negotiate the peers directly.
This works for most of the networks, but if your network is very restrictive it might not work.
If this is the case try to configure one or both of these options:
1. The most reliable and recommended way is to use a [turn server](#configure-a-turn-server)
2. [Forward the ports directly](#port-forward) (this might not work if the firewall blocks udp)

#### Configure a turn server
1. Host and configure a turn server like [coturn](https://github.com/coturn/coturn) or use other services to host one for you.

2. Add your turn server to your WebRTC Ice Server list
```json
{
    "webrtc_ice_servers": [
        {
            "urls": [
                    "stun:l.google.com:19302",
                    "stun:stun.l.google.com:19302",
                    "stun:stun1.l.google.com:19302",
                    "stun:stun2.l.google.com:19302",
                    "stun:stun3.l.google.com:19302",
                    "stun:stun4.l.google.com:19302",
            ]
        },
        {
            "urls": [
                    "turn:yourip.com:3478?transport=udp",
                    "turn:yourip.com:3478?transport=tcp",
                    "turn:yourip.com:5349?transport=tcp"
            ],
            "username": "your username",
            "credential": "your credential"
        }
    ]
}
```
Some (business) firewalls might be very strict and only allow tcp on port 443 for turn connections if that's the case also bind the turn server on port 443 and add `"turn:yourip.com:443?transport=tcp"` to the url's list.

#### Port forward

1. Set the port range used by the WebRTC Peer to a fixed range in the [config](#config)
```json
{
    "webrtc_port_range": {
        "min": 40000,
        "max": 40100
    }
}
```
2. Forward the port range specified in the previous step as `udp`.
If you're using Windows Defender make sure to allow NAT Traversal. Important: If your firewall blocks udp connections this won't work and you need to host a [turn server](#configure-a-turn-server)

3. Configure [WebRTC Nat 1 To 1](#webrtc-nat-1-to-1-ips) to advertise your [public ip](https://whatismyipaddress.com/) (Optional: WebRTC stun servers can usually automatically detect them):
```json
{
    "webrtc_nat_1to1": {
        "ice_candidate_type": "host",
        "ips": [
            "74.125.224.72"
        ]
    }
}
```

It might be helpful to look what kind of nat your pc is behind:
- [Nat Checker](https://www.checkmynat.com/)

### Configuring HTTPS
You can configure HTTPS directly with the Moonlight Web Server.

#### Option A: Let's Encrypt (recommended for Tesla / public access)

The included `setup.ps1` wizard handles this automatically on Windows. Run it and choose option 1 in the certificate step.

For manual use, the `acme-certificate.ps1` script automates obtaining a free, trusted SSL certificate from [Let's Encrypt](https://letsencrypt.org/).

**Prerequisites:**
- A domain name pointing to your public IP (e.g. DDNS like `*.asuscomm.com` — see [Getting a free domain](#getting-a-free-domain-name))
- Port 80 forwarded on your router to the server's local IP (the setup wizard can do this via UPnP)

**Windows (standalone):**
```powershell
.\acme-certificate.ps1
```

The script will prompt for your domain and server URL, then automatically:
1. Generate an account key (reused on subsequent runs)
2. Request a certificate from Let's Encrypt
3. Set up the HTTP-01 challenge via the server's API
4. Wait for validation
5. Save `server/cert.pem` and `server/key.pem` and update `server/config.json`

> **Tip:** Use `-Staging` to test with Let's Encrypt's staging environment first to avoid rate limits.

##### Auto-renewal (Windows Task Scheduler)

The `setup.ps1` wizard creates this scheduled task automatically. To set it up manually:

1. Open **Task Scheduler** → **Create Task**
2. **General** tab: Name it `Moonlight Web Certificate Renewal`, check "Run whether user is logged on or not"
3. **Triggers** tab: New → **On a schedule**, repeat every **60 days**
4. **Actions** tab: New →
   - Program: `powershell.exe`
   - Arguments: `-ExecutionPolicy Bypass -File "C:\path\to\acme-certificate.ps1" -Domain "yourdomain.com" -ServerUrl "http://192.168.1.100:43780"`
   - Start in: `C:\path\to\moonlight-web\`
5. Click OK and enter your Windows password

#### Option B: Self-signed certificate

For local/development use where browser trust warnings are acceptable:

1. Generate a self-signed certificate with the included Python script:

```sh
pip install pyOpenSSL
python ./moonlight-web/web-server/generate_certificate.py
```

2. Copy the files `server/key.pem` and `server/cert.pem` into your `server` directory.

3. Modify the [config](#config) to enable https:
```json
{
    "certificate": {
        "private_key_pem": "./server/key.pem",
        "certificate_pem": "./server/cert.pem"
    }
}
```

> **Note:** Self-signed certificates will show browser warnings and may not work in the Tesla browser.

### Proxying via Apache 2
It's possible to proxy the Moonlight Website using [Apache 2](https://httpd.apache.org/).

Note:
When you want to use https, the Moonlight Website should use http so that Apache 2 will handle all the https encryption.

1. Enable the modules `mod_proxy`, `mod_proxy_wstunnel`

```sh
sudo a2enmod mod_proxy mod_proxy_wstunnel
```

2. Create a new file under `/etc/apache2/conf-available/moonlight-web.conf` with the content:
```
# Example subpath "/moonlight" -> To connect you'd go to "http://yourip.com/moonlight/"
Define MOONLIGHT_SUBPATH /moonlight
# The address and port of your Moonlight Web server
Define MOONLIGHT_STREAMER YOUR_LOCAL_IP:YOUR_PORT

ProxyPreserveHost on
        
# Important: This WebSocket will help negotiate the WebRTC Peers
<Location ${MOONLIGHT_SUBPATH}/api/host/stream>
        ProxyPass ws://${MOONLIGHT_STREAMER}/api/host/stream
        ProxyPassReverse ws://${MOONLIGHT_STREAMER}/api/host/stream
</Location>

ProxyPass ${MOONLIGHT_SUBPATH}/ http://${MOONLIGHT_STREAMER}/
ProxyPassReverse ${MOONLIGHT_SUBPATH}/ http://${MOONLIGHT_STREAMER}/
```

3. Enable the created config file
```sh
sudo a2enconf moonlight-web
```

4. Change [config](#config) to include the [prefixed path](#web-path-prefix)
```json
{
    "web_path_prefix": "/moonlight"
}
```

5. Use https with a certificate (Optional)

## Config
The config file is under `server/config.json` relative to the executable.
Here are the most important settings for configuring Moonlight Web.

For a full list of values look into the [Rust Config module](moonlight-web/common/src/config.rs).

### Credentials
The credentials the Website will prompt you to enter.
Change this from the default value to the credentials for the website.

```json
{
    "credentials": "your password"
}
```

If you set this null authentication will be disabled and the `Authorization` header won't be used in requests.

```json
{
    "credentials": null
}
```

### Two-Factor Authentication (2FA)
Once logged in you can enable 2FA (TOTP) from the **Settings → Security** section.

1. Click **Set Up Two-Factor Authentication**.
2. A 32-character base32 secret key is shown. Enter it into your authenticator app using the "Enter setup key" option (Google Authenticator, Authy, etc.). Set the algorithm to **SHA1**, digits to **6**, and period to **30 s**.
3. Enter the 6-digit code displayed by the app to confirm, then click **Ok**.

From this point every login requires your password **and** the current TOTP code.

The secret is saved into `server/config.json` under the key `totp_secret`. Active sessions are stored in `server/sessions.json` and survive server restarts. Sessions expire automatically after **90 days**.

To disable 2FA, click **Disable Two-Factor Authentication** in the same section.

> **Note:** 2FA only protects the web interface. It has no effect on the Sunshine pairing process.

### Bind Address 
The address and port the website will run on

```json
{
    "bind_address": "127.0.0.1:43780"
}
```

### Https Certificates
If enabled the web server will use https with the provided certificate data

```json
{
    "certificate": {
        "private_key_pem": "./server/key.pem",
        "certificate_pem": "./server/cert.pem"
    }
}
```

### WebRTC Port Range
This will set the port range on the web server used to communicate when using WebRTC

```json
{
    "webrtc_port_range": {
        "min": 40000,
        "max": 40100
    }
}
```

### WebRTC Ice Servers
A list of ice servers for webrtc to use.

```json
{
    "webrtc_ice_servers": [
        {
            "urls": ["stun:stun.cloudflare.com:3478"]
        }
    ]
}
```

### WebRTC Nat 1 to 1 ips
This will advertise the ip as an ice candidate on the web server.
It's recommended to set this but stun servers should figure out the public ip.

`ice_candidate_type`:
- `host` -> This is the ip address of the server and the client can connect to
- `srflx` -> This is the public ip address of this server, like an ice candidate added from a stun server.

```json
{
    "webrtc_nat_1to1": {
        "ice_candidate_type": "host",
        "ips": [
            "74.125.224.72"
        ]
    }
}
```

### WebRTC Network Types
This will set the network types allowed by webrtc.
<br>Allowed values:
- udp4: All udp with ipv4
- udp6: All udp with ipv6
- tcp4: All tcp with ipv4
- tcp6: All tcp with ipv6

```json
{
    "webrtc_network_types": [
        "udp4",
        "udp6",
    ]
}
```

### Web Path Prefix
This is useful when rerouting the web page using services like [Apache 2](#proxying-via-apache-2).
Will always append the prefix to all requests made by the website.

```json
{
    "web_path_prefix": "/moonlight"
}
```

## Contributors
- Thanks a million to [@MrCreativ3001](https://github.com/MrCreativ3001) for the base project!

## Building
Make sure you've cloned this repo with all it's submodules
```sh
git clone --recursive https://github.com/Argon2000/moonlight-web-stream-tsla.git
```
A [Rust](https://www.rust-lang.org/tools/install) [nightly](https://rust-lang.github.io/rustup/concepts/channels.html) installation is required.

There are 2 ways to build Moonlight Web:
- Build it on your system

  When you want to build it on your system take a look at how to compile the crates:
  - [moonlight common sys](#crate-moonlight-common-sys)
  - [moonlight web server](#crate-moonlight-web-server)
  - [moonlight web streamer](#crate-moonlight-web-streamer)

- Compile using [Cargo Cross](https://github.com/cross-rs/cross)

  After you've got a successful installation of cross just run the command in the project root directory
  This will compile the [web server](#crate-moonlight-web-server) and the [streamer](#crate-moonlight-web-streamer)
  ```sh
  cross build --release --target YOUR_TARGET
  ```
  Note: windows only has the gnu target `x86_64-pc-windows-gnu`

### Crate: Moonlight Common Sys
[moonlight-common-sys](./moonlight-common-sys/) are rust bindings to the cpp [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c) library.

Required for building:
- A [CMake installation](https://cmake.org/download/) which will automatically compile the [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c) library
- [openssl-sys](https://docs.rs/openssl-sys/0.9.109/openssl_sys/): For information on building openssl sys go to the [openssl docs](https://docs.rs/openssl/latest/openssl/)
- A [bindgen installation](https://rust-lang.github.io/rust-bindgen/requirements.html) for generating the bindings to the [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c) library

### Crate: Moonlight Web Server
This is the web server for Moonlight Web found at `moonlight-web/web-server/`.
It'll spawn a multiple [streamers](#crate-moonlight-web-server) as a subprocess for handling each stream.

Required for building:
- [moonlight-common-sys](#moonlight-common-sys)

Build the web frontend with [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).
```sh
npm install
npm run build
```
The build output will be in `moonlight-web/web-server/dist`. The dist folder needs to be called `static` and in the same directory as the web server executable.

### Crate: Moonlight Web Streamer
This is the streamer subprocess of the [web server](#crate-moonlight-web-server) and found at `moonlight-web/streamer/`.
It'll communicate via stdin and stdout with the web server to negotiate the WebRTC peers and then continue to communicate via the peer.

Required for building:
- [moonlight-common-sys](#moonlight-common-sys)
