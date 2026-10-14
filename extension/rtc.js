// Peer-to-peer video mesh for up to 4 people, using the "perfect negotiation" pattern
// so simultaneous offers, reconnects and ICE restarts don't deadlock.

const VIDEO_MAX_BITRATE = 350_000; // ~350 kbps per stream keeps 3 uploads OK on normal home internet
const VIDEO_MAX_FPS = 15;

export class Mesh {
  constructor({ selfId, sendSignal, onPeerStream, onPeerGone, onPeerStatus }) {
    this.selfId = selfId;
    this.sendSignal = sendSignal;
    this.onPeerStream = onPeerStream;
    this.onPeerGone = onPeerGone;
    this.onPeerStatus = onPeerStatus || (() => {});
    this.peers = new Map(); // id -> peer
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.localStream = null;
    this.mediaState = { cam: false, mic: false };
  }

  setSelfId(id) { this.selfId = id; }
  setIceServers(servers) { if (Array.isArray(servers) && servers.length) this.iceServers = servers; }

  localTrack(kind) {
    // A disabled (camera off / muted) track isn't sent at all, which saves bandwidth.
    return this.localStream ? this.localStream.getTracks().find(t => t.kind === kind && t.readyState === 'live' && t.enabled) || null : null;
  }

  // Swap local camera/mic on every connection without renegotiating.
  async setLocalStream(stream) {
    this.localStream = stream;
    for (const p of this.peers.values()) await this.attachLocalTracks(p);
  }

  setMediaState(state) {
    this.mediaState = { ...this.mediaState, ...state };
    for (const id of this.peers.keys()) this.sendSignal(id, { mediaState: this.mediaState });
  }

  async attachLocalTracks(p) {
    for (const tr of p.pc.getTransceivers()) {
      const kind = tr.receiver.track && tr.receiver.track.kind;
      if (!kind || tr.stopped || tr.currentDirection === 'stopped') continue;
      if (tr.direction !== 'sendrecv') { try { tr.direction = 'sendrecv'; } catch {} }
      const track = this.localTrack(kind);
      if (tr.sender.track !== track) { try { await tr.sender.replaceTrack(track); } catch {} }
    }
    this.tuneSenders(p);
  }

  tuneSenders(p) {
    for (const sender of p.pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
      params.encodings[0].maxFramerate = VIDEO_MAX_FPS;
      params.degradationPreference = 'balanced';
      sender.setParameters(params).catch(() => {});
    }
  }

  addPeer(id, initiator) {
    this.removePeer(id, true);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const p = {
      id, pc, initiator,
      polite: this.selfId < id,
      makingOffer: false,
      ignoreOffer: false,
      stream: new MediaStream(),
      pendingCandidates: [],
      discTimer: null,
    };
    this.peers.set(id, p);

    pc.ontrack = ({ track }) => {
      p.stream.getTracks().filter(t => t.kind === track.kind).forEach(t => p.stream.removeTrack(t));
      p.stream.addTrack(track);
      this.onPeerStream(id, p.stream);
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.sendSignal(id, { candidate }); };
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        this.sendSignal(id, { description: pc.localDescription });
      } catch (e) {
        console.warn('negotiation failed', e);
      } finally {
        p.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      this.onPeerStatus(id, st);
      if (st === 'connected') {
        clearTimeout(p.discTimer);
        this.tuneSenders(p);
        this.sendSignal(id, { mediaState: this.mediaState });
      } else if (st === 'failed') {
        pc.restartIce();
      } else if (st === 'disconnected') {
        clearTimeout(p.discTimer);
        p.discTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') pc.restartIce(); }, 4000);
      }
    };

    if (initiator) {
      // Always negotiate both audio and video so turning the camera on later needs no renegotiation.
      for (const kind of ['audio', 'video']) {
        const tr = pc.addTransceiver(kind, { direction: 'sendrecv' });
        const track = this.localTrack(kind);
        if (track) tr.sender.replaceTrack(track).catch(() => {});
      }
    }
    return p;
  }

  removePeer(id, silent) {
    const p = this.peers.get(id);
    if (!p) return;
    clearTimeout(p.discTimer);
    try { p.pc.close(); } catch {}
    this.peers.delete(id);
    if (!silent) this.onPeerGone(id);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  async handleSignal(from, data) {
    if (!data) return;
    if (data.mediaState) { this.onPeerStatus(from, null, data.mediaState); return; }
    let p = this.peers.get(from);
    if (!p) {
      if (!data.description || data.description.type !== 'offer') return; // stray candidate from an old connection
      p = this.addPeer(from, false);
    }
    const pc = p.pc;
    try {
      if (data.description) {
        const desc = data.description;
        const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        for (const c of p.pendingCandidates.splice(0)) { try { await pc.addIceCandidate(c); } catch {} }
        if (desc.type === 'offer') {
          await this.attachLocalTracks(p);
          await pc.setLocalDescription();
          this.sendSignal(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        if (!pc.remoteDescription) { p.pendingCandidates.push(data.candidate); return; }
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) console.warn('ice candidate', e); }
      }
    } catch (e) {
      console.warn('signal handling failed', e);
    }
  }
}
