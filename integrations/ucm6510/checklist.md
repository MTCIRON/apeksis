# UCM6510 interoperability gate — deferred, not implemented

M1 file STT/TTS needs no PBX, LiveKit, SIP ports, agent media runtime, or n8n. Voxi's WebSocket transports (ADR 0005) provide barge-in interruption and streaming synthesis/transcription **to a directly connected IP client only**; this repository does not claim a working phone call, SIP/RTP leg, PBX-mediated interruption, transfer execution or production fallback, and no gateway WebSocket has been exercised against this PBX. No dummy SIP Compose service is supplied.

Before implementing the phone slice, record evidence from the real lab:

- [ ] Record UCM6510 firmware, network topology, approved test extensions, and SIP/RTP endpoint versions; back up PBX configuration.
- [ ] Decide peer trunk vs extension registration from the installed firmware. LiveKit SIP is not automatically a normal REGISTERing extension. If registration is necessary, evaluate a dedicated PJSIP/Asterisk intermediary.
- [ ] Read the installed UCM manual; verify peer trunk under `Extension/Trunk > VoIP Trunks`, route patterns, peer IP authentication, firewall rules, SIP signaling and a restricted RTP range. Do not invent production settings.
- [ ] Exchange real INVITE/200/ACK, OPTIONS, BYE, CANCEL; capture redacted signaling and bidirectional media. Test NAT/RTP reachability and teardown after caller hangup.
- [ ] Negotiate G.711 A-law/µ-law and RFC4733 DTMF. Prove mono 8 kHz media ↔ model resampling; no one-way audio, clipping, or missing DTMF.
- [ ] Demonstrate real Turkish greeting with AI disclosure; consent/retention policy must precede any recording.
- [ ] Keep prompts, LLM, tools, memory, and business decisions exclusively in n8n. Media runtime sends schema 1.0 final turns, discards stale generations, validates actions and allowed transfer destinations.
- [ ] Demonstrate speaking, barge-in cancellation, resumed listening, and no playback after a cancelled generation or hangup. (Already proven over the Voxi WebSocket transport by deterministic contract tests; the phone-leg demonstration below is still unexecuted hardware evidence.)
- [ ] Demonstrate allowlisted transfer to a real internal extension using tested REFER or a mediated bridge, including rejection/failure paths.
- [ ] Demonstrate pre-generated offline fallback/human destination on n8n/model/network failure; no retry loop trapping a caller.
- [ ] Restrict trunks and outbound dialing; disable unrestricted inbound Dial Trunk/DISA. Prompt text must never authorize arbitrary dialing.
- [ ] Run three concurrent real calls; measure p50/p95 end-of-speech→audible-playback latency, CPU/GPU, capacity failures, teardown and resource leaks.
- [ ] Block WAN after provisioning and repeat calls. Attach traces, redacted logs, hardware versions, and pass/fail notes before declaring M0/M3 phone gates passed.

Primary references: [Grandstream UCM6510 manual](https://documentation.grandstream.com/knowledge-base/ucm6510-user-manual/), [LiveKit self-hosted SIP](https://docs.livekit.io/transport/self-hosting/sip-server/). Real-device execution remains unverified.
