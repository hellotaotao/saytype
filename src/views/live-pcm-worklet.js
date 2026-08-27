class SayTypePcm16CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples?.length) {
      return true;
    }
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("saytype-pcm16-capture", SayTypePcm16CaptureProcessor);
