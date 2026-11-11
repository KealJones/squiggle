# Native llama.cpp behind a tiny HTTP endpoint: the prompt text WebLLM would have run, completed on the same
# weights (GGUF). For driving the real Squiggle app against a real model on a machine without WebGPU
# (tests/eval/run.mjs --llm). Native is ~100x faster than llama.cpp in WASM on the same 2 CPU cores.
#
#   pip install llama-cpp-python
#   python3 tests/eval/llm_server.py LFM2.5-1.2B-Instruct-Q4_0.gguf 8711 [n_ctx]
#
# POST {prompt, max_tokens, temperature, top_p, repetition_penalty, stop} → {text, prompt_tokens, completion_tokens, seconds}.
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from llama_cpp import Llama
LOG = os.environ.get('LLM_LOG')
m = Llama(sys.argv[1], n_ctx=int(sys.argv[3]) if len(sys.argv) > 3 else 4096, n_threads=2, verbose=False)
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        toks = m.tokenize(b['prompt'].encode(), add_bos=False, special=True)
        t = time.time()
        # Decoded with special tokens kept: LFM2's tool calls sit between <|tool_call_start|> and <|tool_call_end|>,
        # which create_completion's text drops.
        stops, gen, text = b.get('stop') or [], [], ''
        m.reset()
        for tok in m.generate(toks, temp=b.get('temperature', 0.1), top_p=b.get('top_p') or 1.0, top_k=b.get('top_k') or 50,
                              min_p=0, repeat_penalty=b.get('repetition_penalty') or 1.0, reset=True):
            if tok == m.token_eos() or len(gen) >= (b.get('max_tokens') or 1024): break
            gen.append(tok)
            text = m.detokenize(gen, special=True).decode('utf-8', 'ignore')
            hit = next((s for s in stops if s in text), None)
            if hit: text = text[:text.index(hit)]; break
        r = {'text': text, 'prompt_tokens': len(toks), 'completion_tokens': len(gen), 'seconds': round(time.time() - t, 1)}
        if LOG:  # LLM_LOG=path: one line per completion (the prompt's tail and the raw text, special tokens kept)
            with open(LOG, 'a') as f: f.write(json.dumps({'prompt_tail': b['prompt'][-600:], **r}) + '\n')
        body = json.dumps(r).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
HTTPServer(('127.0.0.1', int(sys.argv[2])), H).serve_forever()
