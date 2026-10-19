# Multicrew: hosting a session

One person hosts on their own computer; friends join from their browsers by IP address.

## Host

Needs Node.js 22.6 or newer (`node --version`).

```
cd web
npm install          # first time only
npm run serve        # builds the game, then starts the session server on port 8036
```

The server prints the addresses to use:

```
B-36 multicrew server on port 8036
  You (host): http://localhost:8036
  Crew on your network: http://192.168.1.20:8036
```

Open `http://localhost:8036` yourself first. Enter your name and press "Start the session". The aircraft
is simulated in your browser, so keep that tab open (it keeps running in the background).

Use another port with `npm run serve:nobuild -- 9000` after a build, or `PORT=9000 npm run serve`.

## Crew

Open the address the host gives you (for example `http://192.168.1.20:8036`), enter a name and board. You
start standing behind the pilots; press Tab for the list of stations, or walk with W A S D and press E at
a seat. Each station is held by one crew member at a time. Only the host can reset or start a scenario
(R, Shift+R, N, L).

## Playing over the internet

1. On the host's router, forward TCP port 8036 to the host computer's LAN address.
2. Allow Node through the host's firewall (Windows asks the first time; on macOS allow incoming
   connections for node; on Linux open the port, for example `sudo ufw allow 8036/tcp`).
3. Friends open `http://<the host's public IP>:8036` (search "what is my IP" on the host).

The session is plain HTTP and has no passwords: anyone who has the address can join while it runs.
Stop the server (Ctrl+C) when you are done.

## How the crew stays in sync

The host's browser runs the one simulation for everybody. Each crew member's own walking runs on their
own machine with no delay; positions inside the aircraft are always kept relative to the aircraft, so
everyone rides with the cabin however the aircraft moves. Everything else comes from the host 30 times a
second and is shown 100 ms behind the host, interpolated, which measured below 1 cm of position error at
105 m/s with internet-like delay and jitter (`web/src/net/net_test.ts`). Pilot inputs from a crew member
reach the aircraft after their ping plus about 100 ms.
