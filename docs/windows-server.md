# Running the v2 agent on a Windows machine for a few testers

The server runs on the Windows laptop; a free Cloudflare "quick tunnel" gives it a public
`https://<random>.trycloudflare.com` URL with no router changes, domain or account.
The app has no logins of its own, so a shared passcode (`ACCESS_PASSCODE`) sits in front
of everything that arrives through the tunnel.

## Setup (once)

1. `git clone https://github.com/prayush21/window-design-agent.git`, then `git checkout v2-agent`.
2. Unzip the catalog so `Product Catalog V2-clean\` sits in the repo root next to `package.json`.
3. Install Node 20+ (`winget install OpenJS.NodeJS.LTS`), open a new terminal in the repo, and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
   ```

   It installs dependencies and cloudflared, writes `.env` with a generated passcode,
   stops the laptop sleeping on AC power, and runs the tests. Fill in `GEMINI_API_KEY`
   (and `OPENAI_API_KEY` if needed) when Notepad opens.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1
```

It prints the public URL (also saved to `tunnel-url.txt`). Send testers the URL and the
passcode from `.env`. Leave the window open. `scripts\windows\autostart.ps1` starts it at login.

Owner access is `http://127.0.0.1:3001/v2/` on the laptop itself: no passcode, no run limit,
and the labelling/eval pages still work. Those are blocked for remote users.

## Cost and abuse controls

- `DAILY_RUN_LIMIT` (default 30) and `PER_IP_DAILY_LIMIT` (default 10) cap paid runs from
  remote users; counts persist in `var\usage.json` and reset at local midnight.
  A run is about $0.30-0.60 in live mode. Also set a budget alert/cap on the Google key.
- Five wrong passcodes lock that address out for 15 minutes.
- `DESIGN_AGENT_LIVE=0` in `.env` switches to mock fixtures (free, canned answers).

## Caveats

- The URL changes whenever the tunnel restarts. Quick tunnels have no uptime guarantee.
- The laptop must stay on, awake and online. Set Windows Update active hours.
- Nobody's photos or sessions leave the laptop except to the model providers: uploads,
  traces and renders live under `var\` and `traces\`.
- Changing `ACCESS_PASSCODE` and restarting logs everyone out.
