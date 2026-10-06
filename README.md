# CallSubs

A small 1-on-1 video call web app with live translated subtitles (English ⇄ Brazilian Portuguese).
Static site, no build step, no accounts, no server of its own.

- Video/audio: WebRTC peer-to-peer via [PeerJS](https://peerjs.com) (public signalling server, public STUN).
- Speech-to-text: the browser's Web Speech API, on each device.
- Translation: Chrome's built-in Translator API where available, otherwise [MyMemory](https://mymemory.translated.net).
- Subtitles travel over a WebRTC data channel.

## Use
1. Open the site and tap **New call**.
2. Share the link. The other person opens it in their browser.
3. Allow camera and microphone on both sides.

Add `&fake=1` to a URL to use a generated test video/tone instead of a camera.

## Configure
Edit `config.js`: languages, optional TURN servers, optional MyMemory email.
Anything put in `config.js` is public, because the whole site is public.

## Privacy
- Call audio and video go directly between the two devices (or via a TURN relay if one is configured). They are encrypted by WebRTC.
- Speech recognition is done by the browser vendor's speech service (Google in Chrome, Apple in Safari).
- Recognised text is sent to MyMemory for translation, unless the built-in translator is available.
- Nothing is stored. There is no backend, database, or analytics.
