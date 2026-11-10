# The same endpoint as llm_server.py, backed by llama.cpp's own llama-server instead of llama-cpp-python: for models
# newer than the llama.cpp llama-cpp-python bundles (LFM3 needs llama.cpp b11960 or later, its model card). Prompt
# caching is on, so each round of a turn only processes the tokens it adds.
#
#   llama-server -m LFM3-1.7B-QAD-Q4_0.gguf --port 8712 -c 4096 -sp      (-sp: keep special tokens in the output,
#                                                                          where LFM3's tool calls sit)
#   python3 tests/eval/llama_proxy.py http://127.0.0.1:8712 8711
#   node tests/eval/run.mjs --model WLF3QAD --llm http://127.0.0.1:8711 ...
#
# POST {prompt, max_tokens, temperature, top_p, repetition_penalty, stop} → {text, prompt_tokens, completion_tokens, seconds}.
import json, os, sys, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

BACKEND = sys.argv[1].rstrip('/')
LOG = os.environ.get('LLM_LOG')


def post(path, body):
    req = urllib.request.Request(BACKEND + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=1800) as r:
        return json.loads(r.read())


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        t = time.time()
        # The prompt already carries its special tokens and BOS (the app renders the template itself), so it's tokenized
        # with special tokens parsed and nothing added, then sent as token ids.
        toks = post('/tokenize', {'content': b['prompt'], 'add_special': False, 'parse_special': True})['tokens']
        r = post('/completion', {
            'prompt': toks, 'n_predict': b.get('max_tokens') or 1024, 'temperature': b.get('temperature', 0.1),
            'top_p': b.get('top_p') or 1.0, 'top_k': b.get('top_k') or 50, 'min_p': 0,
            'repeat_penalty': b.get('repetition_penalty') or 1.0, 'stop': b.get('stop') or [], 'cache_prompt': True,
        })
        out = {'text': r.get('content', ''), 'prompt_tokens': r.get('tokens_evaluated', len(toks)),
               'completion_tokens': r.get('tokens_predicted', 0), 'seconds': round(time.time() - t, 1)}
        if LOG:  # one line per completion: the prompt's tail and the raw text
            with open(LOG, 'a') as f: f.write(json.dumps({'prompt_tail': b['prompt'][-600:], **out}) + '\n')
        body = json.dumps(out).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)


HTTPServer(('127.0.0.1', int(sys.argv[2])), H).serve_forever()
