import { useCallback, useEffect, useRef, useState } from 'react';

import { base64ToBytes, getDayPdf, listToday, saveFile, suggestPatients, type PatientCard } from './api';
import { formatDate, formatTime } from './format';
import PatientView from './PatientView';
import { buildZip, type ZipEntry } from './zip';

const MIN_SERVER_QUERY = 3;

export default function HomePage() {
  const [today, setToday] = useState<PatientCard[] | null>(null);
  const [todayError, setTodayError] = useState('');
  const [query, setQuery] = useState('');
  // La respuesta guarda la consulta a la que corresponde: solo se muestra si
  // coincide con lo que hay escrito ahora.
  const [result, setResult] = useState<{ q: string; items: PatientCard[]; error: string } | null>(null);
  const [selected, setSelected] = useState<PatientCard | null>(null);
  const requestSeq = useRef(0);
  // Descarga del día: un PDF por paciente (todos sus consentimientos unidos),
  // nombrado por cédula, todos en un ZIP.
  const [zipProgress, setZipProgress] = useState<{ done: number; total: number } | null>(null);
  const [zipMessage, setZipMessage] = useState('');

  const downloadToday = async () => {
    const patients = today ?? [];
    if (patients.length === 0) return;
    setZipMessage('');
    setZipProgress({ done: 0, total: patients.length });
    const entries: ZipEntry[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const now = new Date();
    // Uno tras otro: cada petición une y registra los consentimientos de un paciente.
    for (const [i, p] of patients.entries()) {
      try {
        const pdf = await getDayPdf(p.patient_id, now);
        entries.push({ name: pdf.filename, data: base64ToBytes(pdf.pdf_base64) });
      } catch (err) {
        // 404: ese paciente no tiene aún un PDF verificado hoy.
        if ((err as { status?: number }).status === 404) skipped.push(p.patient_id);
        else failed.push(`${p.patient_id}: ${(err as Error).message}`);
      }
      setZipProgress({ done: i + 1, total: patients.length });
    }
    setZipProgress(null);
    if (entries.length > 0) {
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      saveFile(buildZip(entries, now), `consentimientos_${day}.zip`);
    }
    setZipMessage(
      [
        entries.length > 0 ? `ZIP con ${entries.length} paciente${entries.length === 1 ? '' : 's'} (un PDF por cédula).` : 'No había PDF verificados para descargar.',
        skipped.length > 0 ? `Sin PDF verificado: ${skipped.join(', ')}.` : '',
        failed.length > 0 ? `No se pudieron descargar: ${failed.join(' · ')}.` : '',
      ]
        .filter(Boolean)
        .join(' ')
    );
  };

  const loadToday = useCallback(async () => {
    try {
      setToday((await listToday()).items);
      setTodayError('');
    } catch (err) {
      setTodayError((err as Error).message);
      setToday([]);
    }
  }, []);

  useEffect(() => {
    listToday().then(
      ({ items }) => setToday(items),
      (err) => {
        setTodayError((err as Error).message);
        setToday([]);
      },
    );
  }, []);

  // Con 3+ letras o números se busca en todos los pacientes (por documento o
  // por nombre); se espera a que se deje de escribir y se descartan las
  // respuestas que lleguen fuera de orden.
  const q = query.trim().replace(/\s+/g, ' ');
  const filteringServer = q.replace(/[^\p{L}0-9]/gu, '').length >= MIN_SERVER_QUERY;
  useEffect(() => {
    if (!filteringServer) return;
    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      try {
        const { items } = await suggestPatients(q);
        if (seq === requestSeq.current) setResult({ q, items, error: '' });
      } catch (err) {
        if (seq === requestSeq.current) setResult({ q, items: [], error: (err as Error).message });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [q, filteringServer]);

  if (selected) {
    return (
      <PatientView
        patient={selected}
        onBack={() => {
          setSelected(null);
          loadToday();
        }}
      />
    );
  }

  const current = filteringServer && result?.q === q ? result : null;
  const searching = filteringServer && !current;
  const searchError = current?.error ?? '';
  const results = current ? current.items : null;
  const cards = filteringServer
    ? results
    : q
      ? (today ?? []).filter((p) => p.patient_id.toLowerCase().includes(q.toLowerCase()) || nameMatches(p.full_name, q))
      : today;

  return (
    <>
      <div className="card search">
        <label htmlFor="cc">Buscar paciente por documento o nombre</label>
        <input
          id="cc"
          className="input"
          type="search"
          autoComplete="off"
          maxLength={60}
          placeholder="Parte del número o del nombre, ej. 8293 o laura gomez"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value.replace(/[^\p{L}0-9 .'-]/gu, ''))}
        />
        {q && !filteringServer && (
          <p className="hint muted">Filtrando los pacientes de hoy. Escriba {MIN_SERVER_QUERY} o más letras o números para buscar en todos.</p>
        )}
      </div>

      <section>
        <div className="section-head">
          <h2>{filteringServer ? `Resultados para “${q}”` : 'Pacientes atendidos hoy'}</h2>
          {!filteringServer && (
            <div className="section-actions">
              {(today?.length ?? 0) > 0 && (
                <button
                  className="btn btn-ghost"
                  disabled={zipProgress !== null}
                  onClick={downloadToday}
                  title="Un PDF por paciente, con todos sus consentimientos de hoy, nombrado por cédula"
                >
                  {zipProgress ? `Preparando ${zipProgress.done}/${zipProgress.total}…` : 'Descargar los de hoy (ZIP)'}
                </button>
              )}
              <button className="btn btn-link" onClick={loadToday}>
                Actualizar
              </button>
            </div>
          )}
          {filteringServer && searching && <span className="muted">Buscando…</span>}
        </div>

        {!filteringServer && zipMessage && <p className="hint muted">{zipMessage}</p>}

        {(filteringServer ? searchError : todayError) && (
          <p className="error banner" role="alert">{filteringServer ? searchError : todayError}</p>
        )}

        {cards === null ? (
          <p className="muted">Cargando…</p>
        ) : cards.length === 0 ? (
          <p className="empty">
            {filteringServer
              ? searching ? 'Buscando…' : `Ningún documento ni nombre coincide con “${q}”.`
              : q ? `Ningún paciente de hoy coincide con “${q}”.` : 'Todavía no hay pacientes atendidos hoy.'}
          </p>
        ) : (
          <ul className="cards">
            {cards.map((p) => (
              <li key={p.patient_id}>
                <button className="patient-card" onClick={() => setSelected(p)}>
                  <strong className="name">{p.full_name ? highlightWords(p.full_name, q) : 'Sin nombre'}</strong>
                  <span className="mono">CC {highlight(p.patient_id, q)}</span>
                  <span className="muted small">
                    {filteringServer
                      ? `${p.consents} consentimiento${p.consents === 1 ? '' : 's'} · último ${formatDate(p.last_at)}`
                      : `${p.consents} hoy · ${formatTime(p.last_at)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Resalta en la cédula la parte que coincide con lo escrito. */
function highlight(id: string, q: string) {
  const i = q ? id.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return id;
  return (
    <>
      {id.slice(0, i)}
      <mark>{id.slice(i, i + q.length)}</mark>
      {id.slice(i + q.length)}
    </>
  );
}

/** Una letra sin tilde y en minúscula (á → a, Ñ → n); conserva la longitud del texto. */
const fold = (text: string) =>
  [...text].map((c) => {
    const f = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    return f.length === 1 ? f : c.toLowerCase();
  }).join('');

const wordsOf = (q: string) => fold(q).split(/[^a-z]+/).filter(Boolean);

/** Igual que el servidor: cada palabra escrita aparece en el nombre, en cualquier orden. */
function nameMatches(name: string | null, q: string) {
  const words = wordsOf(q);
  if (!name || !words.length) return false;
  const folded = fold(name);
  return words.every((w) => folded.includes(w));
}

/** Resalta en el nombre cada palabra escrita, sin importar tildes ni mayúsculas. */
function highlightWords(name: string, q: string) {
  const folded = fold(name);
  const marked = new Array<boolean>(name.length).fill(false);
  for (const w of wordsOf(q)) {
    for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + 1)) {
      marked.fill(true, i, i + w.length);
    }
  }
  if (!marked.includes(true)) return name;
  const parts: { text: string; mark: boolean }[] = [];
  [...name].forEach((c, i) => {
    const last = parts.at(-1);
    if (last && last.mark === marked[i]) last.text += c;
    else parts.push({ text: c, mark: marked[i] });
  });
  return parts.map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>));
}
