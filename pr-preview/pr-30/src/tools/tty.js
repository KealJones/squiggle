// Which commands write to the terminal. just-bash never tells a command where its stdout goes (commands return
// strings; `[ -t 1 ]` is always false), but it runs transform plugins on the parsed script before executing it.
// This one walks the AST and gives every `gh` whose stdout reaches the terminal GH_FORCE_TTY=true, the variable
// real gh reads to act as if it were on a terminal, so `gh repo list` prints its header and table while
// `gh repo list | grep x`, `$(gh …)` and `gh … > file` get the plain tab-separated output, like the real one.
// The terminal here is what the bash tool hands back to the model.

export const TTY_VAR = 'GH_FORCE_TTY';
const TTY_COMMANDS = new Set(['gh']);

const literal = (word) => word && Array.isArray(word.parts) && word.parts.every(p => p.type === 'Literal')
  ? word.parts.map(p => p.value).join('') : null;

// Does one of these redirections send stdout somewhere other than the terminal?
function stdoutElsewhere(redirections = []) {
  return redirections.some(r => {
    if (r.operator === '&>' || r.operator === '&>>') return true;
    if (r.fd != null && r.fd !== 1) return false;
    if (r.operator === '>' || r.operator === '>>' || r.operator === '>|') return true;
    if (r.operator === '>&') { const t = literal(r.target); return !(t === '1' || t === '2'); }   // >&2 still shows
    return false;
  });
}

function mark(node, tty) {
  if (Array.isArray(node)) { for (const x of node) mark(x, tty); return; }
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'Script': return mark(node.statements, tty);
    case 'Statement': return mark(node.pipelines, tty);
    case 'Pipeline': node.commands.forEach((c, i) => mark(c, tty && i === node.commands.length - 1)); return;
    case 'CommandSubstitution': case 'ProcessSubstitution': return mark(node.body, false);
  }
  const own = tty && !stdoutElsewhere(node.redirections);
  if (node.type === 'SimpleCommand' && own && TTY_COMMANDS.has(literal(node.name))
      && !node.assignments.some(a => a.name === TTY_VAR)) {
    node.assignments.unshift({ type: 'Assignment', name: TTY_VAR, value: { type: 'Word', parts: [{ type: 'Literal', value: 'true' }] }, append: false, array: null });
  }
  for (const [k, v] of Object.entries(node)) if (k !== 'type' && v && typeof v === 'object') mark(v, own);
}

export const ttyPlugin = {
  name: 'tty',
  transform({ ast }) { mark(ast, true); return { ast }; },
};
