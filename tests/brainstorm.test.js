import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewFor, transcriptFor, framingOf, nextVoice, systemFor, continueSystem, cutOff, latestSteer, ownTurn, clipMiddle, phaseOf, isRepeat, wrapUpDue, wrapUpSystem, dropThinking, SAMPLING, BEST, PIECE, PERSON } from '../app/src/brainstorm.js';

let n = 0;
const msg = (role, content, extra = {}) => ({ id: 'm' + (++n), role, content, ts: n, thread: null, ...extra });
const seed = msg('user', 'A coffee shop for dogs');
const a1 = msg('assistant', 'Dog-safe pup cups', { voice: 'A' });
const b1 = msg('assistant', 'Who cleans up?', { voice: 'B' });
const steer = msg('user', 'focus on money');
const a2 = msg('assistant', 'Memberships', { voice: 'A' });

test('A goes first, then they alternate', () => {
  assert.equal(nextVoice([seed]), 'A');
  assert.equal(nextVoice([seed, a1]), 'B');
  assert.equal(nextVoice([seed, a1, b1, steer]), 'A');
});

test('each voice sees its own turns as the assistant and the other voice as the user', () => {
  const A = viewFor([seed, a1, b1], 'A').messages;
  assert.deepEqual(A.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(A[0].content, 'A coffee shop for dogs');
  const B = viewFor([seed, a1, b1, a2], 'B').messages;
  assert.deepEqual(B.map(m => [m.role, m.content]), [['user', 'Dog-safe pup cups'], ['assistant', 'Who cleans up?'], ['user', 'Memberships']]);
  assert.equal(viewFor([seed, a1], 'B').topic, 'A coffee shop for dogs');
  assert.match(systemFor('B', 'A coffee shop for dogs'), /A coffee shop for dogs/);
});

test('the person jumping in is marked and merged with the other voice', () => {
  const A = viewFor([seed, a1, b1, steer], 'A').messages;
  assert.equal(A.length, 3);
  assert.equal(A[2].role, 'user');
  assert.match(A[2].content, /^Who cleans up\?\n\nThe person who started this brainstorm steps in: focus on money$/);
});

test('old turns drop off the front to fit, and the view still starts with a user turn', () => {
  const line = [seed];
  for (let i = 0; i < 30; i++) line.push(msg('assistant', `turn ${i} `.repeat(40), { voice: i % 2 ? 'B' : 'A' }));
  const v = viewFor(line, 'A', 300).messages;
  assert.ok(v.length < 31 && v.length >= 1);
  assert.equal(v[0].role, 'user');
  assert.equal(v[v.length - 1].role, 'user');
  assert.match(v[v.length - 1].content, /turn 29/);
});

test('deleted messages and thread replies are left out', () => {
  const gone = msg('assistant', 'x', { voice: 'B', deleted: true });
  const side = msg('user', 'side question', { thread: 't1' });
  assert.deepEqual(viewFor([seed, a1, gone, side], 'B').messages.map(m => m.content), ['Dog-safe pup cups']);
  assert.equal(nextVoice([seed, a1, gone]), 'B');
});

test('B is the critic and starts with the weakest part; neither opens with praise or is told to keep it short', () => {
  assert.match(systemFor('B', 'x'), /critic.*Start every turn with the weakest/s);
  assert.match(systemFor('A', 'x'), /builder/);
  for (const v of ['A', 'B']) for (const f of ['flip', 'transcript']) {
    assert.match(systemFor(v, 'x', '', f), /ever opens? with praise/);
    assert.doesNotMatch(systemFor(v, 'x', '', f), /short paragraph|keep it (short|brief)/i);
  }
});

test('cut off: the runtime\'s own reason first, then the token count, then the text', () => {
  assert.equal(cutOff('half a table', { tokens: 380, finish: 'length' }), true, 'the window ran out before max_tokens');
  assert.equal(cutOff('done.', { tokens: PIECE, finish: 'stop' }), false);
  assert.equal(cutOff('lots of text', { tokens: PIECE }), true, 'no reason given: the count');
  assert.equal(cutOff('done.', { tokens: 200 }), false);
  assert.equal(cutOff('', { tokens: PIECE, finish: 'length' }), false, 'an empty call keeps the last reply\'s numbers; not a cut-off');
  assert.equal(cutOff('x'.repeat(PIECE * 4), null), true, 'no numbers (cloud): estimated from the text');
  assert.equal(cutOff('x'.repeat(400), null), false);
});

test('finishing a cut-off turn: same instructions, then the end of what it wrote and "carry on from there"', () => {
  const sys = continueSystem('B', 'cats', 'a'.repeat(5000) + 'THE END BIT');
  assert.ok(sys.startsWith(systemFor('B', 'cats')));
  assert.match(sys, /cut off by the length limit/);
  assert.match(sys, /THE END BIT/);
  assert.ok(sys.length < systemFor('B', 'cats').length + 2700, 'only the tail is shown back');
});

test('a turn longer than the whole budget keeps its end', () => {
  const doc = msg('assistant', 'START ' + 'word '.repeat(3000) + 'FINAL LINE', { voice: 'A' });
  const v = viewFor([seed, doc], 'B', 500).messages;
  assert.equal(v.length, 1);
  assert.match(v[0].content, /^….*FINAL LINE$/s);
  assert.doesNotMatch(v[0].content, /START/);
  assert.ok(v[0].content.length <= 500 * 3 + 1);
});

test('the person\'s latest steer goes in the system prompt until both voices have answered it', () => {
  assert.equal(latestSteer([seed, a1]), '', 'the idea itself is the topic, not a steer');
  assert.equal(latestSteer([seed, a1, b1, steer]), 'focus on money');
  assert.equal(latestSteer([seed, a1, b1, steer, a2]), 'focus on money', 'B still has to answer it');
  assert.equal(latestSteer([seed, a1, b1, steer, a2, msg('assistant', 'x', { voice: 'B' })]), '');
  assert.match(systemFor('B', 'cats', 'focus on money'), /just stepped in and said: "focus on money"/);
  assert.match(continueSystem('B', 'cats', 'so far', 'focus on money'), /focus on money/);
  assert.doesNotMatch(systemFor('B', 'cats'), /stepped in and said/);
});

test('framing: new brainstorms are transcripts; chats from before the switch (true) stay role flips', () => {
  assert.equal(framingOf({ brainstorm: 'transcript' }), 'transcript');
  assert.equal(framingOf({ brainstorm: 'flip' }), 'flip');
  assert.equal(framingOf({ brainstorm: true }), 'flip');
});

test('transcript: one user turn, every turn labelled, the person included, ending with the ask', () => {
  const v = transcriptFor([seed, a1, b1, steer], 'A').messages;
  assert.equal(v.length, 1);
  assert.equal(v[0].role, 'user');
  assert.equal(v[0].content, `${PERSON}: A coffee shop for dogs\n\nA: Dog-safe pup cups\n\nB: Who cleans up?\n\n${PERSON}: focus on money\n\nThe question: A coffee shop for dogs\nNow write A's next turn.`);
  const sys = systemFor('B', 'cats', '', 'transcript');
  assert.match(sys, /You write B's turns\. B is the critic: starts every turn with the weakest/);
  assert.match(sys, /no "B:" label/);
  assert.doesNotMatch(sys, /user turns/, 'nothing about the other voice being the user');
  assert.match(systemFor('A', 'cats', 'focus on money', 'transcript'), /just stepped in and said: "focus on money"\. This turn follows that direction, whatever B last said/);
  assert.match(continueSystem('A', 'cats', 'half a', '', 'transcript'), /A's turn was cut off by the length limit/);
});

test('transcript: the idea always stays, the oldest turns drop off, and an overlong last turn keeps its end', () => {
  const line = [seed];
  for (let i = 0; i < 30; i++) line.push(msg('assistant', `turn ${i} `.repeat(40), { voice: i % 2 ? 'B' : 'A' }));
  const t = transcriptFor(line, 'A', 400).messages[0].content;
  assert.ok(t.startsWith(`${PERSON}: A coffee shop for dogs\n\n…\n\n`), t.slice(0, 80));
  assert.match(t, /turn 29 \n\nThe question: A coffee shop for dogs\nNow write A's next turn\.$/);
  assert.doesNotMatch(t, /turn 0 /);
  const doc = msg('assistant', 'START ' + 'word '.repeat(3000) + 'FINAL LINE', { voice: 'A' });
  const d = transcriptFor([seed, doc], 'B', 500).messages[0].content;
  assert.match(d, /…[^]*FINAL LINE\n\nThe question: A coffee shop for dogs\nNow write B's next turn\.$/);
  assert.doesNotMatch(d, /START/);
});

test('transcript: a turn ends where another speaker starts, and its own leading label is dropped', () => {
  assert.deepEqual(ownTurn('B: The cache will blow up.\n\nA: Then cap it.\n\nB: Fine.'), { text: 'The cache will blow up.', other: true });
  assert.deepEqual(ownTurn('Graph attention.\n\nA: Let me flesh out the core idea.'), { text: 'Graph attention.', other: true }, 'its own label again: a new turn');
  assert.deepEqual(ownTurn(`Ok.\n\n${PERSON}: thanks`), { text: 'Ok.', other: true });
  assert.deepEqual(ownTurn('**B:** bold label'), { text: 'bold label', other: false });
  assert.deepEqual(ownTurn('Plan A: cheap. Plan B: fast.\nAB: testing'), { text: 'Plan A: cheap. Plan B: fast.\nAB: testing', other: false }, 'labels only at a line start');
  // Review 2026-11-12: a Q/A list inside a turn ended it. A speaker starts after a blank line, as transcriptFor joins turns.
  const faq = 'FAQ:\nQ: price?\nA: $5 a cup\nB: or a subscription';
  assert.deepEqual(ownTurn(faq), { text: faq, other: false });
  assert.deepEqual(ownTurn('B: x\nA: y', 'flip'), { text: 'B: x\nA: y', other: false }, 'the role flip keeps what it wrote');
});

// Review 2026-11-12: the idea went in the system prompt and the transcript head untrimmed, so an idea over ~4,000
// characters left B no room for A's turn, and ~7,000 overflowed LFM3's 4K window.
test('a long idea is cut in the middle and the latest turn still fits in a 4K window', () => {
  const idea = 'IDEA START ' + 'notes '.repeat(1500) + ' IDEA END';   // ~9,000 characters
  const longSeed = msg('user', idea);
  const turnA = msg('assistant', 'A has a plan', { voice: 'A' });
  const est = (t) => Math.ceil(t.length / 3);
  const system = systemFor('B', idea, '', 'transcript');
  assert.ok(system.length < 2000, `system prompt ${system.length} chars`);
  assert.match(system, /IDEA START[^]* … [^]*IDEA END/);
  const budget = 4096 - PIECE - est(system) - 200;
  const t = transcriptFor([longSeed, turnA], 'B', budget).messages[0].content;
  assert.match(t, /\n\nA: A has a plan\n\nThe question: IDEA START[^]*\nNow write B's next turn\.$/, 'B sees A');
  assert.match(t, /IDEA START[^]* … [^]*IDEA END/);
  assert.ok(est(system) + est(t) + PIECE <= 4096, `prompt + reply ${est(system) + est(t) + PIECE} tokens`);
  assert.equal(clipMiddle('short', 100), 'short');
});

test('role flip: a budget at or below zero keeps a short end of the turn, not all of it', () => {
  const doc = msg('assistant', 'x'.repeat(12000) + 'END', { voice: 'A' });
  const v = viewFor([seed, doc], 'B', -100).messages;
  assert.ok(v[0].content.length <= 302, `${v[0].content.length} chars`);
  assert.match(v[0].content, /END$/);
});

// Chat s0mwe4yoqe000frhk4 (2026-11-12): asked which noodle shape, it argued one cheese ratio for twenty turns.
test('phases: diverge for four turns, one cluster turn, then converge; each tied to the question', () => {
  const v = (n) => [seed, ...Array.from({ length: n }, (_, i) => msg('assistant', 'x', { voice: i % 2 ? 'B' : 'A' }))];
  assert.deepEqual([0, 3, 4, 5, 9].map(n => phaseOf(v(n))), ['diverge', 'diverge', 'cluster', 'converge', 'converge']);
  const diverge = systemFor('B', 'noodles?', '', 'transcript', { phase: 'diverge' });
  assert.match(diverge, /only generating options/);
  assert.doesNotMatch(diverge, /critic|weakest/, 'no judging while options are listed');
  assert.match(diverge, /What the person who started it said: noodles\?/);
  const cluster = systemFor('A', 'noodles?', '', 'transcript', { phase: 'cluster' });
  assert.match(cluster, /restates the person's idea or question[^]*groups every option/);
  assert.ok(cluster.includes(BEST));
  const converge = systemFor('B', 'noodles?', '', 'transcript', { phase: 'converge' });
  assert.match(converge, /B is the critic/);
  assert.match(converge, /drifts away from it gets pulled back/);
  assert.ok(converge.includes(`ends every turn with a line starting "${BEST}"`));
  assert.match(systemFor('B', 'noodles?', '', 'transcript', { retry: true }), /last try repeated an earlier turn/);
});

const LOOP_B = "The 0.25 cup cheese per cup noodle volume is a solid, practical target — but \"per cup\" of cooked tagliatelle or elbow can be ambiguous because dried-to-cooked ratios vary by brand and how much water you add to cook them. For home cooks without a scale, weighing one handful of dry noodles (about 30 g) and filling it with roughly 10 g cheese gives a reliable feel: that's about 1/3 teaspoon grated sharp cheddar per handful, which scales up well. If the sauce pools in the center after adding cheese, you're under-ratioing; if it slides off before baking, over-ratio. Also, parmesan should be blended into the cheese mixture first so it disperses evenly rather than clumping on ridges.";
const LOOP_A1 = "To turn the test batch into a repeatable recipe, I'd lay out the exact steps: **cook 1 lb tagliatelle or elbow** (about 2–3 cups cooked), grate **¼ cup sharp cheddar + ¼ cup grated parmesan**, pour a thin layer of hot mac n cheese sauce over them, let sit 30 seconds so the cheese adheres to ridges before adding the remaining mixture. Then bake at **350°F for ~20 minutes** until bubbly and golden. Taste after the first 5 minutes — if coating feels too light, stir in **1 tbsp milk or ½ tsp butter**; if too heavy/grainy, add a splash more broth or extra cheese. This standardized run gives you a concrete ratio without guessing, and the parmesan blend keeps the melt glossy rather than chalky.\n\nIf";
const LOOP_A2 = "To scale the test batch into a repeatable recipe, I'd lay out the exact steps: **cook 1 lb tagliatelle or elbow** (about 2–3 cups cooked), grate **¼ cup sharp cheddar + ¼ cup grated parmesan**, pour a thin layer of hot mac n cheese sauce over them, let sit 30 seconds so the cheese adheres to ridges before adding the remaining mixture. Then bake at **350°F for ~20 minutes** until bubbly and golden. Taste after the first 5 minutes — if coating feels too light, stir in **1 tbsp milk or ½ tsp butter**; if too heavy or grainy, add a splash more broth or extra cheese. This standardized run gives you a concrete ratio without guessing, and the parmesan blend keeps the melt glossy rather than chalky.";
test('repeats: the real loop from s0mwe4yoqe000frhk4 is caught; fresh turns and short ones are not', () => {
  assert.equal(isRepeat(LOOP_B, ['something else entirely', LOOP_B]), true, 'B posted this four times');
  assert.equal(isRepeat(LOOP_A2, [LOOP_A1]), true, 'A\'s recipe again with a word changed');
  assert.equal(isRepeat("The 1:2–3 cheese-to-noodle weight ratio is a solid starting point, but \"roughly\" leaves too much room for guesswork — you could end up with either a watery sauce or a cheese-heavy mess. For mac n cheese specifically, I'd tighten it to **1 part grated sharp cheddar per 4 parts cooked noodles by weight** (so roughly 0.25 cup cheese to 1 cup tagliatelle) and test on one batch before scaling; the ridges of elbow hold better than flat sheets, which reduces surface-area loss and keeps the sauce from pooling in the center where it runs off. Also, mixing in parmesan isn't just about gloss — it prevents graininess when heated through, so don't skip that step even if the base looks fine. And remember, the \"medium-thick ribbon\" suggestion earlier was about strand count, not weight; a 12-inch wide elbow at standard thickness (~5 mm) should land near that sweet spot without being overly dense.", ["The idea of matching noodle thickness to sauce volume is sound, but \"wide flat sheet\" or \"thick lasagna disc\" shapes introduce risk — a rolled disc collapses and loses structure, while flat sheets can become soggy if the cheese-to-noodle ratio isn't adjusted for their lower surface area. For mac n cheese specifically, I'd reject the ultra-wide ribbons; instead, a **12-inch wide elbow tagliatelle** gives enough strands to wrap around the fork without drowning in sauce, and the natural ridges hold the cheese better than smooth sheets. Fine spaghetti would be too thin, letting sauce pool and cheese run off before it sets. So narrow down to medium-thick ribbon or classic tagliatelle/elbow, not super fine or overly thick discs."]), false, 'B\'s first two turns: same topic, new content');
  assert.equal(isRepeat('Elbows. Shells.', ['Elbows. Shells.']), false, 'under 30 words: left alone');
  const old = [seed, msg('assistant', LOOP_A1, { voice: 'A' }), msg('assistant', LOOP_B, { voice: 'B' }), msg('assistant', LOOP_A2, { voice: 'A' }), msg('assistant', LOOP_B, { voice: 'B' })];
  const t = transcriptFor(old, 'A').messages[0].content;
  assert.equal(t.split(LOOP_B).length - 1, 1, 'a repeat saved before this is shown once');
  assert.equal(t.split('\n\nA: ').length - 1, 1, 'A\'s near-copy is left out too');
});

// Chat s0mweal56h0007v3ch (2026-11-12): B's first testing turn was its own earlier list with A's best answer pasted after.
const PASTE_B_LIST = "- Agrees that the landscape is wide and no single shape dominates yet.  \n- Suggests **self-organizing reinforcement loops** where training signals reshape network topology on the fly, blending adaptation with stability.  \n- Proposes **bi-directional information flow models**, allowing forward and backward passes to interact, mirroring biological processing.  \n- Mentions **modular attention-free transformers** that replace self-attention with learned local receptive fields, cutting memory overhead while preserving expressivity.  \n- Recommends **energy-aware pruning guided by hardware co-design**, removing redundant weights during inference without degrading accuracy.  \n- Points out **graph-of-graph neural networks** that compose specialized subgraphs for different data modalities, scaling compositionally rather than monolithically.";
const PASTE_A_CLUSTER = "- A acknowledges the breadth of proposals and agrees that no single architecture currently matches neural nets on all fronts.  \n- Highlights **dynamic, data-driven topology** as a recurring theme: TDA-guided structure, real-time rewiring, graph-of-graph composition, and self-organizing loops all reshape connections during inference or training.  \n- Emphasizes **hardware-native efficiency**: neuromorphic clusters, event-driven spikes, and energy-aware pruning aim to make large models runnable on low-power chips without sacrificing accuracy.  \n- Concludes by framing the ideal alternative as a **hybrid meta-circuit plus continuous dynamics**, where symbolic reasoning, spiking computation, and adaptive topology co-evolve.\n\nBest answer so far: An architecture that is **continuously reconfigured by local feature importance (feedback-driven topology)**, runs natively on neuromorphic hardware with spiking neurons, and learns its own module layout via meta-learning and reinforcement signals—essentially a dynamic, biologically-inspired, hardware-co-designed system rather than a fixed deep net.";
const PASTE_B_TESTING = "- Agrees that the landscape is wide and no single shape dominates yet.  \n- Suggests **self-organizing reinforcement loops** where training signals reshape network topology on the fly, blending adaptation with stability.  \n- Proposes **bi-directional information flow models**, allowing forward and backward passes to interact, mirroring biological processing.  \n- Mentions **modular attention-free transformers** that replace self-attention with learned local receptive fields, cutting memory overhead while preserving expressivity.  \n- Recommends **energy-aware pruning guided by hardware co-design**, removing redundant weights during inference without degrading accuracy.  \n- Points out **graph-of-graph neural networks** that compose specialized subgraphs for different data modalities, scaling compositionally rather than monolithically.  \n\nBest answer so far: An architecture that is **continuously reconfigured by local feature importance (feedback-driven topology)**, runs natively on neuromorphic hardware with spiking neurons, and learns its own module layout via meta-learning and reinforcement signals—essentially a dynamic, biologically-inspired, hardware-co-designed system rather than a fixed deep net.";
test('repeats: a turn pasted together from two earlier turns is caught; best-answer lines may repeat', () => {
  assert.equal(isRepeat(PASTE_B_TESTING, ["- A suggests **spiking neural networks (SNNs)** as a biologically plausible alternative, leveraging event-driven computation for efficiency and interpretability.  \n- Proposes **liquid neural networks** or **neural ODE-based architectures**, which model continuous dynamics rather than discrete layers, potentially offering better adaptability over time.  \n- Mentions **graph neural networks with dynamic topology** to handle irregular data structures more naturally than fixed-weight nets.  \n- Recommends **hybrid symbolic-numeric models** that combine neural components with analytical reasoning, aiming to match net expressivity while improving reliability in edge cases.  \n- Points out **attention-free transformers** built on local attention windows or structured recurrence, seeking to reduce quadratic cost without sacrificing performance.  \n- Suggests **modular, pluggable micro-architectures** where each module handles specific subdomains, enabling specialization and easier scaling.", "- A adds **topological data analysis (TDA)-guided architectures**, where the network's structure is shaped by persistent homology features of input data, ensuring robustness to noise and irregularity.  \n- Proposes **self-supervised continual learning frameworks** that embed architecture adaptation into the training loop, allowing the model to evolve without catastrophic forgetting.  \n- Suggests **neuro-morphic spiking clusters** that mimic brain-scale parallelism with local communication, aiming for orders-of-magnitude speedup on neuromorphic substrates.  \n- Mentions **dynamic graph rewiring during inference** based on real-time feature importance scores, creating a feedback-driven topology.  \n- Recommends **meta-circuit search via reinforcement learning**, automatically discovering compact circuit motifs that outperform hand-designed nets on benchmark tasks.  \n- Points out **quantum-inspired tensor-network hybrids** that compress high-order correlations using entanglement-like structures in classical hardware.", PASTE_B_LIST, PASTE_A_CLUSTER]), true);
  assert.equal(isRepeat(PASTE_A_CLUSTER, ["- A suggests **spiking neural networks (SNNs)** as a biologically plausible alternative, leveraging event-driven computation for efficiency and interpretability.  \n- Proposes **liquid neural networks** or **neural ODE-based architectures**, which model continuous dynamics rather than discrete layers, potentially offering better adaptability over time.  \n- Mentions **graph neural networks with dynamic topology** to handle irregular data structures more naturally than fixed-weight nets.  \n- Recommends **hybrid symbolic-numeric models** that combine neural components with analytical reasoning, aiming to match net expressivity while improving reliability in edge cases.  \n- Points out **attention-free transformers** built on local attention windows or structured recurrence, seeking to reduce quadratic cost without sacrificing performance.  \n- Suggests **modular, pluggable micro-architectures** where each module handles specific subdomains, enabling specialization and easier scaling.", "- A adds **topological data analysis (TDA)-guided architectures**, where the network's structure is shaped by persistent homology features of input data, ensuring robustness to noise and irregularity.  \n- Proposes **self-supervised continual learning frameworks** that embed architecture adaptation into the training loop, allowing the model to evolve without catastrophic forgetting.  \n- Suggests **neuro-morphic spiking clusters** that mimic brain-scale parallelism with local communication, aiming for orders-of-magnitude speedup on neuromorphic substrates.  \n- Mentions **dynamic graph rewiring during inference** based on real-time feature importance scores, creating a feedback-driven topology.  \n- Recommends **meta-circuit search via reinforcement learning**, automatically discovering compact circuit motifs that outperform hand-designed nets on benchmark tasks.  \n- Points out **quantum-inspired tensor-network hybrids** that compress high-order correlations using entanglement-like structures in classical hardware.", PASTE_B_LIST]), false, 'the grouping turn itself is new');
  const fresh = 'I would push back on the neuromorphic part: spiking chips are still niche, training them is hard, and nobody has matched transformer accuracy on language with them yet, so the hardware story is a bet rather than an advantage.';
  const best = `${BEST} a dynamic, hardware co-designed system with adaptive topology instead of a fixed deep net.`;
  assert.equal(isRepeat(`${fresh}\n\n${best}`, [`Something else entirely that was said before about graphs and spikes and chips.\n\n${best}`]), false, 'same answer, new argument');
});

test('wrap-up: due after six testing turns (and six more after each wrap-up), written for the person', () => {
  const voices = (n) => Array.from({ length: n }, (_, i) => msg('assistant', 'x' + i, { voice: i % 2 ? 'B' : 'A' }));
  assert.equal(wrapUpDue([seed, ...voices(10)]), false);
  assert.equal(wrapUpDue([seed, ...voices(11)]), true, '4 listing + 1 grouping + 6 testing');
  const wrapped = [seed, ...voices(11), msg('assistant', 'summary', { decision: true })];
  assert.equal(wrapUpDue(wrapped), false);
  assert.equal(wrapUpDue([...wrapped, ...voices(6)]), true);
  const sys = wrapUpSystem('noodles?');
  for (const part of ['**Summary**', '**Decision**', '**Why**', '**Still open**']) assert.ok(sys.includes(part), part);
  assert.match(sys, /What the person who started it said: noodles\?/);
  const t = transcriptFor(wrapped, 'S').messages[0].content;
  assert.match(t, /\n\nWrap-up: summary\n\nThe question: A coffee shop for dogs\nNow write the wrap-up\.$/);
  assert.match(systemFor('A', 'q', '', 'transcript'), /in the first person/);
});

// Chat s0mwec78t10005me61 (2026-11-12): "an app that just shows the last thing said by each person" came back as a
// chat app with history, search and a "last N turns" toggle.
test('the person\'s idea is the point: every phase and the wrap-up say to keep it as it is', () => {
  for (const phase of ['diverge', 'cluster', 'converge']) {
    for (const v of ['A', 'B']) assert.match(systemFor(v, 'x', '', 'transcript', { phase }), /Take it exactly as they said it[^]*Don't fix it, soften it, or turn it into something ordinary/);
  }
  assert.match(wrapUpSystem('x'), /Don't fix it, soften it/);
  assert.match(systemFor('B', 'x', '', 'transcript'), /anywhere A made the person's idea safer or more ordinary/);
  assert.match(systemFor('A', 'x', '', 'transcript'), /no questions for anyone at the end/);
  assert.ok(SAMPLING.diverge.temperature > 0.5 && SAMPLING.converge.temperature > 0.5, 'hotter than LFM3\'s 0.1');
});

test('a stray </think> with thinking off: the turn is what comes after it', () => {
  const leaked = 'Best answer so far: stacked timeline.</think>I\'d merge the stacked timeline with speaker labels.';
  assert.equal(dropThinking(leaked), 'I\'d merge the stacked timeline with speaker labels.');
  assert.equal(ownTurn(leaked).text, 'I\'d merge the stacked timeline with speaker labels.');
  assert.equal(dropThinking('still drafting </think>'), 'still drafting', 'nothing after it yet (streaming): keep the draft');
  assert.equal(dropThinking('no tags here'), 'no tags here');
});
