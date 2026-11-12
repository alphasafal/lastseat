// Vercel entry point. The whole API is one function: Vercel keeps an instance alive while it
// has requests in flight (an open event stream counts), and one instance serves many requests
// at once, so the in-process pieces - the SSE hub, the change stream, the board cache - work
// the same way as on a long-running server. Each instance tails its own change stream, which
// is how an event committed on one instance reaches people connected to another.

import { boot } from '../server/src/boot.js';

export default await boot();
