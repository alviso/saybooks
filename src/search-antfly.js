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
    // The fused score is a reciprocal-rank number: it says which lists a hit sat near the top
    // of, not how strong the match was. So each hit also says which side matched (the words,
    // the meaning, or both) and carries the semantic similarity where there is one.
    hits: hits.map(h => {
      const ix = h._index_scores || {};
      const via = [ix.full_text != null && 'words', ix[INDEX] != null && 'meaning'].filter(Boolean).join(' + ');
      return { id: h._id, score: Math.round(h._score * 1000) / 1000, via, similarity: ix[INDEX] != null ? Math.round(ix[INDEX] * 100) / 100 : null, ...h._source };
    }),
    // Fused scores are tiny when only one side matched; a top score under this is "nothing
    // here really", which a pure semantic search can never say.
    confident: max >= 0.02,
    note: !hits.length ? 'Antfly found nothing.' : max < 0.02 ? 'Weak matches only: nothing in the books says this in so many words.' : `${hits.length} related, ranked by meaning.`,
  };
}

module.exports = { enabled, related };
