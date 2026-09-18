'use strict';
/**
 * An optional retrieval backend for core_search: Antfly, running locally, holding the same
 * books as documents. Off unless SAYBOOKS_ANTFLY_TABLE names a table. The LIKE search stays
 * as it is; this adds a `related` list beside it, ranked by meaning rather than substring,
 * each hit naming the entity it came from so a person or an agent can open it.
 *
 * Talks to Antfly through its CLI for now: the standalone node answers the CLI on 8080 but
 * not plain HTTP as far as curl can tell, and shelling out is honest about that until the
 * transport is understood. One process per search, ~150 ms warm.
 */
const { execFileSync } = require('child_process');

const TABLE = process.env.SAYBOOKS_ANTFLY_TABLE || null;
const BIN = process.env.SAYBOOKS_ANTFLY_BIN || 'antfly';
const INDEX = process.env.SAYBOOKS_ANTFLY_INDEX || 'text';

const enabled = () => !!TABLE;

/** Semantic plus full-text, fused; the fused score is what makes an honest empty possible. */
function related(q, limit = 8) {
  if (!TABLE) return null;
  const words = String(q).trim().split(/\s+/).filter(w => /^[\w.-]+$/.test(w)).slice(0, 6);
  const args = ['query', '--table', TABLE, '--semantic-search', q, '--indexes', INDEX,
    '--fields', 'kind,title,company,status,application_status', '--limit', String(limit)];
  if (words.length) args.push('--full-text-search', words.map(w => `body:${w}`).join(' '));
  let out;
  try { out = execFileSync(BIN, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return { error: `antfly: ${String(e.message).split('\n')[0].slice(0, 120)}` }; }
  let j; try { j = JSON.parse(out); } catch { return { error: 'antfly returned something that was not JSON' }; }
  const hits = (((j.responses || [])[0] || {}).hits || {}).hits || [];
  const max = hits.length ? hits[0]._score : 0;
  return {
    hits: hits.map(h => ({ id: h._id, score: Math.round(h._score * 1000) / 1000, ...h._source })),
    // Fused scores are tiny when only one side matched; a top score under this is "nothing
    // here really", which a pure semantic search can never say.
    confident: max >= 0.02,
    note: !hits.length ? 'Antfly found nothing.' : max < 0.02 ? 'Weak matches only: nothing in the books says this in so many words.' : `${hits.length} related, ranked by meaning.`,
  };
}

module.exports = { enabled, related };
