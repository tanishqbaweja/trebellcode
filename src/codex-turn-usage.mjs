// What each running Codex turn used, summed over all the model requests the turn makes.
//
// After every model request of a thread Codex sends thread/tokenUsage/updated, whose tokenUsage holds `total`, the thread's running
// total since Codex loaded it, and `last`, that one request's usage. A turn that calls tools makes a request after each tool, so
// `last` alone is one request of many: what the turn used is how far the total moved while it ran.
//
// The server does not read a plain stream of those updates:
// - each window that shows the thread reads them on a connection of its own, so an update comes once per window, the copies
//   interleaved in any order (and a resume can replay the last one). A total the thread took in lately is such a copy;
// - while no window shows the thread none of its updates reach the server, yet Codex runs on, so the total before a turn's first
//   update can hold whole turns the server never saw. So the growth counts only between two totals of one turn (a thread runs one
//   turn at a time), and a turn's first update counts the request's own usage (`last`), which in an unbroken stream is the same.
//   So does a total with a counter below the one before it: Codex loaded the thread again, or compacted it;
// - an update of a turn that is not running (a late one, after the turn ended) counts toward nothing, but its total is the
//   thread's newest all the same, so its requests never count toward a turn that runs.
// Codex counts cache reads and writes inside the input tokens and reasoning inside the output tokens, so the usage given back never
// shows a part above its whole. Memory stays bounded: by default the 500 threads updated most lately are kept, each with its 64
// newest totals.

const COUNTERS = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"];
// Each counter that is a part of another, with the counter it is part of.
const PART_OF = [["cachedInputTokens", "inputTokens"], ["cacheWriteInputTokens", "inputTokens"], ["reasoningOutputTokens", "outputTokens"]];

// A usage breakdown as its six counters, in COUNTERS order. A counter that is missing, not a number or not above zero reads 0.
function tokenCounts(breakdown) {
  const counts = {};
  for (const name of COUNTERS) {
    const value = Number(breakdown?.[name]);
    counts[name] = value > 0 ? value : 0;
  }
  return counts;
}

// Forgets the oldest entries of a Map or a Set (its insertion order) until at most `keep` are left.
function keepNewest(entries, keep) {
  for (const key of entries.keys()) {
    if (!(entries.size > keep)) return;
    entries.delete(key);
  }
}

// What a running turn's update adds to the turn: the growth since the turn's own earlier total, or the request's own usage when
// there is no such total or a counter went down.
function stepOf(total, earlier, request) {
  if (!earlier || COUNTERS.some(name => total[name] < earlier[name])) return tokenCounts(request);
  const growth = {};
  for (const name of COUNTERS) growth[name] = total[name] - earlier[name];
  return growth;
}

// A turn's sum as given back: null while it holds nothing, else a copy with each part held to its whole.
function presented(sum) {
  if (!COUNTERS.some(name => sum[name] > 0)) return null;
  const usage = { ...sum };
  for (const [part, whole] of PART_OF) usage[part] = Math.min(sum[whole], sum[part]);
  return usage;
}

// One thread's updates so far: the totals it took in lately, the newest total with the turn it came with, and the sum of the turn
// being counted (one turn at a time).
class ThreadTally {
  #recent = new Set();
  #newest = null;
  #counting = null;

  constructor(totalsToRemember) {
    this.totalsToRemember = totalsToRemember;
  }

  // False when the thread took this total in lately (another window's copy); otherwise remembers it among the newest.
  isNew(total) {
    const key = Object.values(total).join("|");
    if (this.#recent.has(key)) return false;
    this.#recent.add(key);
    keepNewest(this.#recent, this.totalsToRemember);
    return true;
  }

  // Makes `total` the thread's newest, from `turn`; gives back the one it replaces when that came from the same turn.
  replaceNewest(turn, total) {
    const earlier = this.#newest?.turn === turn ? this.#newest.total : null;
    this.#newest = { turn, total };
    return earlier;
  }

  // The turn does not run: if it is the one being counted, its count ends.
  stopCounting(turn) {
    if (this.#counting?.turn === turn) this.#counting = null;
  }

  // Adds a step to the turn's sum, which starts from nothing when another turn (or none) was being counted, and gives the sum.
  addStep(turn, step) {
    if (this.#counting?.turn !== turn) this.#counting = { turn, sum: tokenCounts(null) };
    const { sum } = this.#counting;
    for (const name of COUNTERS) sum[name] += step[name];
    return sum;
  }
}

export function createCodexTurnUsage({ maxThreads = 500, rememberedTotals = 64 } = {}) {
  const tallies = new Map();
  // The thread's tally, now its most recently used; the least recently used threads beyond maxThreads are forgotten.
  const tallyOf = thread => {
    const tally = tallies.get(thread) ?? new ThreadTally(rememberedTotals);
    tallies.delete(thread);
    tallies.set(thread, tally);
    keepNewest(tallies, maxThreads);
    return tally;
  };
  return {
    // The usage so far of the running turn this update counts toward, or null when it counts toward none (or the turn has none yet).
    update({ threadId, turnId, tokenUsage, running = false } = {}) {
      const thread = threadId ? String(threadId) : "";
      const turn = turnId ? String(turnId) : "";
      if (!thread || !turn || !tokenUsage?.total) return null;
      const tally = tallyOf(thread);
      const total = tokenCounts(tokenUsage.total);
      if (!tally.isNew(total)) return null;
      const earlier = tally.replaceNewest(turn, total);
      if (!running) {
        tally.stopCounting(turn);
        return null;
      }
      return presented(tally.addStep(turn, stepOf(total, earlier, tokenUsage.last)));
    },
  };
}
