// Tells browserengine.js whether this browser can start a worker from inside
// a worker, which the multi-threaded engine does for each of its threads.
// Run as /engine/probe.js; it starts itself again as /engine/probe.js#inner.
if (self.location.hash === "#inner") {
  postMessage("inner");
} else {
  try {
    const inner = new Worker("/engine/probe.js#inner");
    inner.onmessage = () => postMessage("yes");
    inner.onerror = event => { event.preventDefault(); postMessage("no"); };
  } catch (error) {
    postMessage("no");
  }
}
