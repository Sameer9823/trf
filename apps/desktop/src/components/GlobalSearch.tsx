import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AnalysisStatus, CoaStatus, Priority, TrfStatus } from '@trf/shared';
import { formatDate } from './Badges';

const DEBOUNCE_MS = 300;
const LIMIT = 5;
const MIN_LENGTH = 2;

interface TrfHit {
  id: number; trfNumber: string; status: TrfStatus; priority: Priority;
  trfDate: string | null; productName: string | null; batchNumber: string | null; customerName: string | null;
}
interface AnalysisHit {
  id: number; trfId: number; trfNumber: string; testName: string; status: AnalysisStatus;
  dueDate: string | null; resultText: string | null;
}
interface CoaHit {
  id: number; trfId: number; coaNumber: string | null; status: CoaStatus; trfNumber: string; productName: string | null;
}
interface SearchResults { trfs: TrfHit[]; analysis: AnalysisHit[]; coas: CoaHit[] }

const EMPTY: SearchResults = { trfs: [], analysis: [], coas: [] };

/** The list pages the "see all" links can open. */
type ListName = 'trf' | 'analysis' | 'coa';

/**
 * Global search. One box covers the three things people actually look up: a TRF
 * number, an analysis test, and a certificate number. Each group navigates to
 * the record itself, with a "see all" line that drops the term into the matching
 * list filter. The server already applies each role's scope, so nothing here
 * needs to know who is allowed to see what.
 */
export function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);

  const trimmed = term.trim();
  const active = trimmed.length >= MIN_LENGTH;

  useEffect(() => {
    if (!active) { setResults(EMPTY); setSearching(false); setFailed(false); return; }
    let cancelled = false;
    setSearching(true);
    setFailed(false);
    const timer = setTimeout(() => {
      void window.trf.request<SearchResults>({
        method: 'GET', path: `/api/search?q=${encodeURIComponent(trimmed)}&limit=${LIMIT}`,
      }).then((res) => {
        if (cancelled) return;
        setSearching(false);
        // A failed search must not read as "no matches", so it is reported apart.
        if (res.ok && res.data) setResults(res.data);
        else { setResults(EMPTY); setFailed(true); }
      });
    }, DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [trimmed]);

  // Clicking anywhere else closes the suggestion list.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function go(path: string) {
    setOpen(false);
    setTerm('');
    setResults(EMPTY);
    navigate(path);
  }

  const openTrf = (id: number) => go(`/trfs/${id}`);
  const openAnalysis = (hit: AnalysisHit) => go(`/analysis?search=${encodeURIComponent(hit.testName)}`);
  const openCoa = (hit: CoaHit) => go(`/coa?search=${encodeURIComponent(hit.coaNumber ?? hit.trfNumber)}`);

  const showAll = (list: ListName) => {
    go(`/${list}?search=${encodeURIComponent(trimmed)}`);
  };

  // The Enter key goes to the list of whichever group has the most matches,
  // which is almost always the one the person meant.
  function onEnter() {
    if (!active) return;
    const counts: Record<ListName, number> = {
      trf: results.trfs.length, analysis: results.analysis.length, coa: results.coas.length,
    };
    const best = (Object.entries(counts) as [ListName, number][]).sort((a, b) => b[1] - a[1])[0];
    showAll(best && best[1] > 0 ? best[0] : 'trf');
  }

  const total = results.trfs.length + results.analysis.length + results.coas.length;
  const atLimit = (list: TrfHit[] | AnalysisHit[] | CoaHit[]) => list.length >= LIMIT;

  return (
    <div className="search" ref={boxRef}>
      <input
        className="topbar__search"
        placeholder="Search TRF, test, certificate…"
        value={term}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }}
        aria-label="Global search"
      />
      {open && active && (
        <div className="search__results">
          {searching && <div className="search__row muted">Searching…</div>}
          {!searching && failed && (
            <div className="search__row muted">The search could not be completed. Check the connection and try again.</div>
          )}
          {!searching && !failed && total === 0 && (
            <div className="search__row muted">No TRF, test or certificate matches “{trimmed}”.</div>
          )}

          {!searching && !failed && results.trfs.length > 0 && (
            <>
              <div className="search__group">TRFs</div>
              {results.trfs.map((hit) => (
                <button key={`t${hit.id}`} className="search__row" onClick={() => openTrf(hit.id)}>
                  <span className="search__no">{hit.trfNumber}</span>
                  <span className="search__meta">
                    {hit.productName ?? 'No product'} · {hit.batchNumber ?? 'No batch'} · {formatDate(hit.trfDate)}
                  </span>
                  <span className="muted">{hit.status}</span>
                </button>
              ))}
              {atLimit(results.trfs) && (
                <button className="search__row search__row--all" onClick={() => showAll('trf')}>
                  See all TRFs for “{trimmed}”
                </button>
              )}
            </>
          )}

          {!searching && !failed && results.analysis.length > 0 && (
            <>
              <div className="search__group">Analysis tests</div>
              {results.analysis.map((hit) => (
                <button key={`a${hit.id}`} className="search__row" onClick={() => openAnalysis(hit)}>
                  <span className="search__no">{hit.testName}</span>
                  <span className="search__meta">
                    {hit.trfNumber} · due {formatDate(hit.dueDate)}
                    {hit.resultText ? ` · ${hit.resultText}` : ''}
                  </span>
                  <span className="muted">{hit.status}</span>
                </button>
              ))}
              {atLimit(results.analysis) && (
                <button className="search__row search__row--all" onClick={() => showAll('analysis')}>
                  See all tests for “{trimmed}”
                </button>
              )}
            </>
          )}

          {!searching && !failed && results.coas.length > 0 && (
            <>
              <div className="search__group">Certificates</div>
              {results.coas.map((hit) => (
                <button key={`c${hit.id}`} className="search__row" onClick={() => openCoa(hit)}>
                  <span className="search__no">{hit.coaNumber ?? 'Draft (not numbered)'}</span>
                  <span className="search__meta">
                    {hit.trfNumber}{hit.productName ? ` · ${hit.productName}` : ''}
                  </span>
                  <span className="muted">{hit.status}</span>
                </button>
              ))}
              {atLimit(results.coas) && (
                <button className="search__row search__row--all" onClick={() => showAll('coa')}>
                  See all certificates for “{trimmed}”
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
