/* Imported first by every probe entry point. Node resolves names (`dns.lookup`, which every check
   makes through the address guard) on libuv's thread pool, four threads by default, and a check
   whose lookup waits for a thread waits with its clock running. At 300 checks a second with four
   threads, lookups queued and the probe fell behind; with 64 it kept up (`decisions.md`, the probe
   benchmark). libuv reads this once, when the pool first starts, so it must be set before any
   lookup. An operator's own value wins. */

process.env.UV_THREADPOOL_SIZE ??= "64";

export {};
