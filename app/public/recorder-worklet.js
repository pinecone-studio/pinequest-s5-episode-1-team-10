// Runs on the audio thread: forwards each 128-sample microphone block to lib/record.ts.
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0][0];
    if (channel) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
