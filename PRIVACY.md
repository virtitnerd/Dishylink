# Privacy Policy

Dishylink is an open-source app that monitors the performance and health of
your Starlink. This page describes what the app does with your data.

## What stays on your machine

Dishylink talks directly to your dish and router over your own LAN, including
while its window is closed. Everything it measures — throughput, latency,
power draw, obstruction, outages, thermal events, radio temps, device lists —
is written to local storage on your machine and is never transmitted
anywhere. There is no analytics and no telemetry collection by us. We do not
see your data; we never receive it.

Dishylink also offers an optional standalone server component (`backend/`,
or its Docker image) for running it headless on your own machine or home
server instead of as a desktop app or extension. This is still entirely
yours: it runs on hardware you control, talks only to your own dish, router,
and — if you connect one — your own Starlink account, and stores everything
locally exactly like the desktop app and extension do. It is not a service we
operate, and nothing it records or handles reaches us.

## The optional "connect account" feature

If you choose to sign in with your own Starlink account (the "Cloud account"
tab), the app opens a Starlink login window and keeps the resulting session
on your device only:

- On desktop, the session is stored in your app's local data directory,
  encrypted with your OS's keychain where available.
- In the browser extension, the session is stored in the extension's own
  storage area, inside your browser profile. No website and no other
  extension can read it. It is not encrypted at rest, so anything with
  access to your browser profile on disk could.
- The session is used solely to read your own plan, billing, and usage data
  directly from `starlink.com` on your behalf, in response to your own
  requests.
- It is never sent to us or to any third party — we have no server that
  could receive it. Disconnecting the account clears the stored session.
  In the extension, disconnecting clears only Dishylink's copy — your own
  starlink.com login in the browser is left signed in.

This feature is entirely opt-in. If you never sign in, no Starlink account
session is created or stored.

## Third parties

Two exceptions to "never leaves your machine," neither carrying any personal
data:

- The in-app speed test measures your connection against Cloudflare's public
  speed-test infrastructure, the same way any browser-based speed test does.
- The sky view fetches public satellite orbital data (TLEs) for the Starlink
  constellation from CelesTrak, an established public source for this kind of
  data, to plot which satellites are overhead.

## Open source

Dishylink's source is public, so you can verify all of the above yourself —
see the repository this file lives in.

## Changes

If a future feature changes what leaves your machine, this document will be
updated before that feature ships, and any such feature will require its own
explicit opt-in.

## Contact

Questions about this policy: hello@dishylink.com
