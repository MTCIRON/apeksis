# ADR 0002: SIP interoperability deferred
Status: Deferred, not production qualified

LiveKit Server + LiveKit SIP is the first candidate, not an implemented call path. No UCM6510 firmware, peer IPs, credentials or lab media endpoint are available. M0 SIP gate is explicitly deferred for the requested M1 first task. No SIP/RTP ports are exposed by default and no dummy agent container is supplied. Pipecat, if selected after a live spike, is a media adapter only. Compare maintained LiveKitTransport against LiveKit Agents media lifecycle; neither may own agent decisions.

Exit gate: capture INVITE/ACK/BYE/CANCEL/OPTIONS and codec SDP, two-way PCMA/PCMU RTP, RFC4733, allowlisted transfer, early hangup, unavailable AI fallback and three concurrent calls on actual UCM firmware. A peer trunk is not extension REGISTER support. Take PBX backup and use test route only.
