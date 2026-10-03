export const audioEvidenceScript = `(() => {
  const NativeContext = window.AudioContext;
  const evidence = window.earrrAudioEvidence = {
    pianoPeak: 0, voicePeak: 0, voiceFrames: 0, samples: 0, voiceStarts: 0, microphoneRequests: 0, sampleVoices: []
  };
  const contexts = [];
  window.AudioContext = class extends NativeContext {
    constructor(...args) {
      super(...args);
      contexts.push(this);
      this.firstAnalyser = null;
    }
    createAnalyser() {
      const analyser = super.createAnalyser();
      if (!this.firstAnalyser) {
        this.firstAnalyser = analyser;
        const samples = new Float32Array(256);
        const timer = setInterval(() => {
          if (this.state === 'closed') { clearInterval(timer); return; }
          analyser.getFloatTimeDomainData(samples);
          for (const sample of samples) evidence.pianoPeak = Math.max(evidence.pianoPeak, Math.abs(sample));
        }, 15);
      }
      return analyser;
    }
    createBufferSource() {
      const source = super.createBufferSource();
      const start = source.start.bind(source);
      const stop = source.stop.bind(source);
      let record;
      source.start = (...args) => {
        if (source.buffer && source.buffer.duration > 3) {
          evidence.samples++;
          record = { playbackRate: source.playbackRate.value, start: args[0] ?? this.currentTime, stop: Infinity };
          evidence.sampleVoices.push(record);
        }
        return start(...args);
      };
      source.stop = (...args) => {
        if (record) record.stop = args[0] ?? this.currentTime;
        return stop(...args);
      };
      return source;
    }
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    const result = play.apply(this, args);
    if (this.id === 'earrr-coach-audio' && this.srcObject) {
      const remoteStream = this.srcObject;
      result.then(() => {
        evidence.voiceStarts++;
        const context = new NativeContext();
        const stream = remoteStream;
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        const silent = context.createGain();
        silent.gain.value = 0;
        source.connect(analyser);
        analyser.connect(silent);
        silent.connect(context.destination);
        const samples = new Float32Array(256);
        context.resume();
        const timer = setInterval(() => {
          if (this.paused || this.srcObject !== remoteStream) { clearInterval(timer); context.close(); return; }
          analyser.getFloatTimeDomainData(samples);
          let peak = 0;
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
          evidence.voicePeak = Math.max(evidence.voicePeak, peak);
          if (peak > 0.001) evidence.voiceFrames++;
        }, 15);
      }).catch(() => {});
    }
    return result;
  };
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (...args) => { evidence.microphoneRequests++; return capture(...args); };
})();`;
