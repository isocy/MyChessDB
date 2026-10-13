// Move, capture, castle, check and mate sounds, made in the browser (no audio
// files). Shared by the best-move page and the puzzle page.
let audioContext=null;

export function playMoveSound(kind) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if(audioContext.state==="suspended") audioContext.resume();
    const now=audioContext.currentTime;
    const patterns={
      move:[[440,0.06,0.04,0]],
      capture:[[330,0.08,0.06,0],[220,0.12,0.07,0]],
      castle:[[392,0.07,0.04,0],[523,0.13,0.07,0]],
      check:[[660,0.08,0.05,0],[880,0.14,0.08,0]],
      mate:[[660,0.08,0.06,0],[523,0.08,0.06,0],[330,0.2,0.1,0]],
      ui:[[520,0.05,0.035,0]],
      complete:[[523,0.16,0.05,0],[659,0.16,0.05,0.14],[784,0.18,0.06,0.28],[1047,0.6,0.07,0.44]],
      wrong:[[311,0.12,0.06,0],[233,0.22,0.06,0.1]]
    };
    for(const [frequency,duration,volume,offset] of patterns[kind]||patterns.move) {
      const start=now+(offset||0);
      const oscillator=audioContext.createOscillator();
      const gain=audioContext.createGain();
      oscillator.type=kind==="capture"?"square":"sine";
      oscillator.frequency.value=frequency;
      gain.gain.setValueAtTime(volume,start);
      gain.gain.exponentialRampToValueAtTime(0.001,start+duration);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start); oscillator.stop(start+duration);
    }
  } catch(error) {
    console.warn("Move sound unavailable",error);
  }
}
