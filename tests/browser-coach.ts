export const controlledCoachScript = `(() => {
  let channel;
  class Channel extends EventTarget {
    readyState = 'connecting';
    active = null;
    send(data) {
      const event = JSON.parse(data);
      if (event.type === 'response.create') {
        this.active = { id: crypto.randomUUID(), status: 'in_progress', metadata: event.response?.metadata, output: [] };
        const response = this.active;
        queueMicrotask(() => this.emit({ type: 'response.created', response }));
      } else if (event.type === 'response.cancel' && this.active) {
        const response = { ...this.active, status: 'cancelled' };
        this.active = null;
        queueMicrotask(() => this.emit({ type: 'response.done', response }));
      } else if (event.type === 'output_audio_buffer.clear') {
        queueMicrotask(() => this.emit({ type: 'output_audio_buffer.cleared' }));
      }
    }
    emit(value) {
      const event = new MessageEvent('message', { data: JSON.stringify(value) });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    }
    close() { this.readyState = 'closed'; this.onclose?.(); }
  }
  window.RTCPeerConnection = class {
    connectionState = 'new';
    addTransceiver() { return { sender: { replaceTrack: async () => {} } }; }
    createDataChannel() { channel = new Channel(); this.channel = channel; return channel; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\\r\\n' + 'test'.repeat(40) }; }
    async setLocalDescription() {}
    async setRemoteDescription() {
      this.connectionState = 'connected';
      queueMicrotask(() => { this.channel.readyState = 'open'; this.channel.onopen?.(); });
    }
    close() { this.connectionState = 'closed'; }
  };
  window.earrrCoachFixture = {
    ready: () => Boolean(channel?.active),
    delta: text => {
      if (!channel?.active) throw new Error('No response is active.');
      channel.emit({ type: 'response.output_audio_transcript.delta', response_id: channel.active.id, delta: text });
    },
    tool: (name, args) => {
      if (!channel?.active) throw new Error('No response is active.');
      const response = { ...channel.active, status: 'completed', output: [
        { type:'function_call', name, call_id:crypto.randomUUID(), arguments:JSON.stringify(args) }
      ] };
      channel.active = null;
      channel.emit({ type:'response.done', response });
    },
    reply: text => {
      if (!channel?.active) throw new Error('No response is active.');
      const id = channel.active.id;
      const response = { ...channel.active, status:'completed', output: [
        { type:'message', content:[{ type:'audio', transcript:text }] }
      ] };
      channel.active = null;
      channel.emit({ type:'response.output_audio_transcript.delta', response_id:id, delta:text });
      channel.emit({ type:'response.done', response });
      channel.emit({ type:'output_audio_buffer.stopped', response_id:id });
    }
  };
})();`;
