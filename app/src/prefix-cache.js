// Prompt-prefix reuse for raw completions on WebLLM (Keal, 2026-11-11: "not meeting the cache every turn").
//
// WebLLM empties the model's cache before every raw completion (preparePrefillInput calls resetChat, and
// getInputData refuses a text completion unless the cache is empty), so each call re-read the whole prompt:
// a reply with five tool steps over a 3K prompt read ~15K tokens. WebLLM's own KV checkpoints only take a pure
// KV cache, and LFM3 is hybrid: its conv layers keep a running state that can't be rewound (RNNState PopN only
// goes back max_history steps, which WebLLM sets to 1).
//
// What works on both kinds of state is forking a sequence at its end (vm.builtin.kv_state_fork_sequence; paged
// KV shares pages copy-on-write, RNN state copies a few hundred KB). So the caches get room for two sequences:
// 0 is the one WebLLM reads and writes, 1 holds a snapshot of a prompt prefix. While a prompt is read, a snapshot
// is forked at the furthest point the next call is sure to render the same (`snapshotPoint`). On the next call,
// if the snapshot's tokens are an exact prefix of the new prompt, sequence 0 becomes a fork of it and only the
// rest is read; anything else (a changed system prompt, a new turn, a different tool list) reads the whole
// prompt as before. Reuse is decided on token ids, never on text, so a mismatch can only cost time.
//
// It reaches into WebLLM's pipeline (0.2.86/0.2.87: getInputData, resetKVCache, embedAndForward,
// filledKVCacheLength, kvCache, rnnState, vm, tvm, fKVCacheRemoveSequence) and leaves a pipeline alone if any of
// that is missing, or if the model came from an artifact manifest.

// Where the next snapshot goes, as a token count. `open` is the token ids that open an assistant turn's thinking
// (LFM3: <|im_start|>assistant\n<think>), `close` the id that ends it (</think>). The template keeps only the
// last assistant turn's thinking, so when that turn has thinking the next call will drop it: the snapshot stops
// right after that turn's <think>. Otherwise everything up to the generation prompt stays the same; the last
// token is left out so there's always something to read (WebLLM needs logits from the last piece).
export function snapshotPoint(ids, open, close) {
  const n = ids.length;
  if (n < 2) return 0;
  const ends = [];
  if (open && open.length) {
    for (let i = 0; i + open.length <= n; i++) {
      let ok = true;
      for (let j = 0; j < open.length; j++) if (ids[i + j] !== open[j]) { ok = false; break; }
      if (ok) ends.push(i + open.length);
    }
  }
  // The last <think> opener is the generation prompt's when the prompt ends inside it (thinking on) or right
  // after it (thinking off: <think></think>); the one before is the last assistant turn in the history.
  const gen = ends.length && ends[ends.length - 1] >= n - 1 ? ends.length - 1 : -1;
  const prev = gen >= 1 ? ends[gen - 1] : gen === -1 && ends.length ? ends[ends.length - 1] : -1;
  if (prev >= 0 && prev < n && ids[prev] !== close) return Math.min(prev, n - 1);
  return n - 1;
}

export const startsWith = (ids, prefix) => {
  if (!prefix || prefix.length > ids.length) return false;
  for (let i = 0; i < prefix.length; i++) if (ids[i] !== prefix[i]) return false;
  return true;
};

// Installs reuse on every loaded pipeline of `engine` that supports it. `mark`: { open, close } as text, from
// the tool format (toolformats/lfm3.js cacheMark). Returns a handle with the stats of the last call, or null.
export function reusePrefix(engine, mark, { log = console } = {}) {
  const pipes = engine && engine.loadedModelIdToPipeline;
  if (!mark || !pipes || typeof pipes.values !== 'function') return null;
  const handle = { pipelines: 0, last: null, totals: { calls: 0, reused: 0, read: 0 } };
  for (const p of pipes.values()) {
    try { if (install(p, mark, handle, log)) handle.pipelines += 1; } catch (e) { log.warn('Squiggle: prompt reuse is off for this model:', String((e && e.message) || e)); }
  }
  return handle.pipelines ? handle : null;
}

function install(p, mark, handle, log) {
  if (!p || p.squiggleReuse || p.artifact !== undefined) return false;
  for (const k of ['getInputData', 'resetKVCache', 'embedAndForward', 'getActiveKVStates']) if (typeof p[k] !== 'function') return false;
  const { tvm, vm } = p;
  if (!tvm || !vm || typeof vm.getFunction !== 'function' || typeof p.fKVCacheRemoveSequence !== 'function' || typeof p.fKVCacheAddSequence !== 'function') return false;
  if (p.slidingWindowSize !== undefined && p.slidingWindowSize !== -1) return false;   // a model-wide window can't be forked past its sink
  const S = (v) => tvm.scalar(v, 'int64');
  tvm.beginScope();
  let fork;
  try {
    fork = tvm.detachFromCurrentScope(tvm.getGlobalFunc('vm.builtin.kv_state_fork_sequence'));
    // The same caches WebLLM made (LLMChatPipeline's constructor), with room for two sequences instead of one.
    const T = (x) => tvm.makeShapeTuple([x]);
    // A fork copies the page it was cut in, so a few spare pages; WebLLM still stops at the context window.
    if (p.kvCache !== undefined) {
      const kv = tvm.detachFromCurrentScope(vm.getFunction('create_tir_paged_kv_cache')(T(2), T(p.contextWindowSize + 32), T(p.prefillChunkSize), T(16), T(0)));
      try { p.kvCache.dispose(); } catch {}
      p.kvCache = kv;
    }
    if (p.rnnState !== undefined) {
      const rnn = tvm.detachFromCurrentScope(vm.getFunction('create_rnn_state')(T(2), T(p.maxHistorySize || 1)));
      try { p.rnnState.dispose(); } catch {}
      p.rnnState = rnn;
    }
  } finally {
    tvm.endScope();
  }
  const enc = (s) => Array.from(p.tokenizer.encode(s));
  const open = enc(mark.open);
  const close = mark.close ? enc(mark.close) : [];
  if (!open.length || close.length !== 1) return false;   // markers that aren't stable tokens: nothing to cut on

  const st = { snap: null };
  const each = (fn) => { for (const s of p.getActiveKVStates()) fn(s); };
  const drop = () => { if (st.snap) { each((s) => p.fKVCacheRemoveSequence(s, S(1))); st.snap = null; } };

  // WebLLM's resetKVCache clears every sequence; with a snapshot kept, only sequence 0 is started over.
  const resetKVCache = p.resetKVCache;
  p.resetKVCache = function () {
    if (!st.snap) return resetKVCache.call(this);
    each((s) => { this.fKVCacheRemoveSequence(s, S(0)); this.fKVCacheAddSequence(s, S(0)); });
  };
  resetKVCache.call(p);   // the new caches start with sequence 0, like WebLLM's

  const getInputData = p.getInputData;
  p.getInputData = async function () {
    const conv = this.conversation;
    if (!conv || !conv.isTextCompletion) { drop(); return getInputData.call(this); }
    const out = await getInputData.call(this);   // the whole prompt, read against an empty sequence 0
    const [data, , embedSize] = out;
    if (data.length !== 1 || !Array.isArray(data[0])) { drop(); return out; }
    const ids = data[0];
    let done = 0;
    if (st.snap && st.snap.length < ids.length && startsWith(ids, st.snap)) {
      each((s) => { this.fKVCacheRemoveSequence(s, S(0)); fork(s, S(1), S(0), S(-1)); });
      done = st.snap.length;
      this.filledKVCacheLength = done;
    } else {
      drop();
    }
    const reused = done;
    const at = snapshotPoint(ids, open, close[0]);
    if (at > done) {
      // Read up to the snapshot point here, fork it off, and leave the rest to WebLLM.
      const size = Math.max(1, this.prefillChunkSize || 128);
      for (let i = done; i < at; i += size) {
        const piece = ids.slice(i, Math.min(at, i + size));
        const logits = await this.embedAndForward([piece], piece.length);
        try { logits && logits.dispose && logits.dispose(); } catch {}
      }
      drop();
      each((s) => fork(s, S(0), S(1), S(-1)));
      st.snap = ids.slice(0, at);
      done = at;
    } else if (at < done) {
      drop();                                     // can't fork further back than what's read; next call reads it all
    }
    const rest = ids.slice(done);
    const stats = { prompt: ids.length, reused, read: ids.length - reused, snapshot: st.snap ? st.snap.length : 0 };
    handle.last = stats;
    handle.totals.calls += 1; handle.totals.reused += reused; handle.totals.read += stats.read;
    if (reused) log.info(`Squiggle: reused ${reused} of ${ids.length} prompt tokens; reading ${stats.read}.`);
    return [[rest], rest.length, embedSize];
  };
  p.squiggleReuse = true;
  return true;
}
