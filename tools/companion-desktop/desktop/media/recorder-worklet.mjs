// Audio-only adaptation of AAAAGENT media/recorder-worklet.mjs, pinned
// 2752349bcc7f7137b8b9e4ff9cccf34026d77aad. No camera; bounded PCM only.
class YukiRecorder extends AudioWorkletProcessor {
  constructor() {
    super(); this.done = false; this.samples = 0;
    this.port.onmessage = ({ data }) => { if (data === 'finish' && !this.done) { this.done = true; this.port.postMessage({ finished: true }); } };
  }
  process(inputs) {
    if (this.done) return false;
    const channels = inputs[0];
    if (channels?.length && channels[0].length) {
      const length = channels[0].length; this.samples += length;
      if (this.samples > Math.min(1440000, sampleRate * 30)) { this.done = true; this.port.postMessage({ error: 'AUDIO_LIMIT' }); return false; }
      const mono = new Float32Array(length);
      for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
      this.port.postMessage({ samples: mono }, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('yuki-recorder', YukiRecorder);
