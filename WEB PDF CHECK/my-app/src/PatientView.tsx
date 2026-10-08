import { useCallback, useEffect, useState } from 'react';

import { getPdfUrl, searchAccess, searchConsents, type AccessItem, type ConsentItem, type PatientCard } from './api';
import { formatBytes, formatDate, humanize, isToday, shortHash } from './format';
import PdfModal from './PdfModal';

type Tab = 'consents' | 'access';

export default function PatientView({ patient, onBack }: { patient: PatientCard; onBack: () => void }) {
  const [consents, setConsents] = useState<ConsentItem[] | null>(null);
  const [access, setAccess] = useState<AccessItem[] | null>(null);
  const [tab, setTab] = useState<Tab>('consents');
  const [showOlder, setShowOlder] = useState(false);
  const [preview, setPreview] = useState<ConsentItem | null>(null);
  const [error, setError] = useState('');
  const closePreview = useCallback(() => setPreview(null), []);

  useEffect(() => {
    let alive = true;
    searchConsents(patient.patient_id)
      .then(({ items }) => alive && setConsents(items))
      .catch((err) => {
        if (!alive) return;
        setError((err as Error).message);
        setConsents([]);
      });
    return () => {
      alive = false;
    };
  }, [patient.patient_id]);

  const openAccess = async () => {
    setTab('access');
    if (access) return;
    setError('');
    try {
      setAccess((await searchAccess(patient.patient_id)).items);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const todays = (consents ?? []).filter((c) => isToday(c.timestamp_utc));
  const older = (consents ?? []).filter((c) => !isToday(c.timestamp_utc));
  const name = patient.full_name ?? consents?.find((c) => c.log.subject?.full_name)?.log.subject?.full_name;

  return (
    <>
      <button className="btn btn-link back" onClick={onBack}>
        ← Volver
      </button>

      {error && <p className="error banner" role="alert">{error}</p>}

      <section className="card results">
        <div className="patient">
          <h2>{name ?? 'Paciente'}</h2>
          <span className="muted">Documento {patient.patient_id}</span>
        </div>

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'consents'} className="tab" onClick={() => setTab('consents')}>
            Consentimientos{consents ? ` (${consents.length})` : ''}
          </button>
          <button role="tab" aria-selected={tab === 'access'} className="tab" onClick={openAccess}>
            Registro de accesos
          </button>
        </div>

        {tab === 'consents' &&
          (consents === null ? (
            <p className="muted">Cargando…</p>
          ) : consents.length === 0 ? (
            <p className="empty">Sin consentimientos para el documento {patient.patient_id}.</p>
          ) : (
            <>
              <h3 className="group-title">Hoy</h3>
              {todays.length > 0 ? (
                <ConsentList items={todays} onPreview={setPreview} onError={setError} />
              ) : (
                <p className="muted">Sin consentimientos hoy.</p>
              )}

              {older.length > 0 &&
                (showOlder || todays.length === 0 ? (
                  <>
                    <h3 className="group-title">Anteriores</h3>
                    <ConsentList items={older} onPreview={setPreview} onError={setError} />
                  </>
                ) : (
                  <button className="btn btn-ghost more" onClick={() => setShowOlder(true)}>
                    Ver consentimientos anteriores ({older.length})
                  </button>
                ))}
            </>
          ))}

        {tab === 'access' && (access ? <AccessList items={access} /> : <p className="muted">Cargando…</p>)}
      </section>

      {preview && <PdfModal consent={preview} onClose={closePreview} />}
    </>
  );
}

function ConsentList({
  items,
  onPreview,
  onError,
}: {
  items: ConsentItem[];
  onPreview: (c: ConsentItem) => void;
  onError: (m: string) => void;
}) {
  return (
    <ul className="list">
      {items.map((c) => (
        <ConsentRow key={c.consent_id} item={c} onPreview={onPreview} onError={onError} />
      ))}
    </ul>
  );
}

function ConsentRow({
  item,
  onPreview,
  onError,
}: {
  item: ConsentItem;
  onPreview: (c: ConsentItem) => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const verified = item.pdf?.verified === true;

  const download = async () => {
    setBusy(true);
    onError('');
    try {
      // S3 responde con Content-Disposition: attachment → el navegador descarga
      // sin salir de esta página.
      const { url } = await getPdfUrl(item.consent_id, false);
      window.location.assign(url);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const log = item.log;
  return (
    <li className="row">
      <div className="row-main">
        <div className="row-info">
          <strong>{log.template?.title ?? (humanize(log.subject?.medical_exam_type) || item.consent_id)}</strong>
          <span className="muted">
            {log.template?.code ? `${log.template.code} v${log.template.version} · ` : ''}
            {formatDate(item.timestamp_utc)} · {humanize(log.capture_metadata?.clinic_location_id) || 'Sin sede'}
          </span>
        </div>
        {item.event_type === 'CONSENT_DECLINED' ? <span className="badge badge-danger">Rechazado</span> : null}
        <span className={`badge ${verified ? 'badge-ok' : 'badge-warn'}`}>{verified ? 'PDF verificado' : 'PDF pendiente'}</span>
        <div className="actions">
          <button className="btn btn-primary" disabled={!verified} onClick={() => onPreview(item)}>
            Ver PDF
          </button>
          <button className="btn btn-ghost" disabled={!verified || busy} onClick={download}>
            {busy ? 'Preparando…' : 'Descargar'}
          </button>
          <button className="btn btn-link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Ocultar registro' : 'Ver registro'}
          </button>
        </div>
      </div>

      {open && (
        <div className="detail">
          <dl>
            <dt>Consentimiento</dt>
            <dd className="mono">{item.consent_id}</dd>
            <dt>Formulario</dt>
            <dd>
              {log.template?.code ? (
                <>
                  {log.template.code} v{log.template.version} · {humanize(log.subject?.medical_exam_type)}{' '}
                  {log.template_ref?.verified ? (
                    <span className="badge badge-ok" title={`SHA-256 ${log.template_ref.sha256 ?? ''}`}>Plantilla verificada</span>
                  ) : (
                    <span className="badge badge-warn" title={log.template_ref?.reason ?? ''}>Plantilla no publicada</span>
                  )}
                </>
              ) : (
                <span className="muted">No registrado (consentimiento anterior a las plantillas en AWS)</span>
              )}
            </dd>
            <dt>Firmado (tablet)</dt>
            <dd>{formatDate(item.timestamp_utc)}</dd>
            <dt>Recibido (servidor)</dt>
            <dd>{formatDate(item.received_at_utc)}</dd>
            <dt>Operador</dt>
            <dd className="mono">{log.capture_metadata?.operator_id ?? '—'}</dd>
            <dt>Dispositivo</dt>
            <dd>
              {[log.device_context?.device_brand, log.device_context?.device_model].filter(Boolean).join(' ') || '—'}
              {log.device_context?.ip_address ? ` · IP ${log.device_context.ip_address}` : ''}
            </dd>
            <dt>PDF</dt>
            <dd>
              {item.pdf ? (
                <>
                  {formatBytes(item.pdf.size_bytes)} · SHA-256{' '}
                  <span className="mono" title={item.pdf.sha256 ?? ''}>{shortHash(item.pdf.sha256)}</span>
                </>
              ) : (
                'Sin PDF'
              )}
            </dd>
          </dl>

          <h3>Cadena de eventos</h3>
          <ol className="events">
            {item.events.map((ev) => (
              <li key={ev.key}>
                <strong>
                  {ev.seq}. {EVENT_LABELS[ev.event_type] ?? humanize(ev.event_type)}
                </strong>{' '}
                <span className="muted">{formatDate(ev.recorded_at_utc)}</span>
                <div className="mono small" title={ev.sha256}>
                  sha256 {shortHash(ev.sha256)}
                  {ev.prev_hash ? ` · anterior ${shortHash(ev.prev_hash)}` : ''}
                </div>
              </li>
            ))}
          </ol>

          <details>
            <summary>Registro completo (JSON)</summary>
            <pre>{JSON.stringify(log, null, 2)}</pre>
          </details>
        </div>
      )}
    </li>
  );
}

const EVENT_LABELS: Record<string, string> = {
  CONSENT_SIGNED: 'Consentimiento firmado',
  PDF_VERIFIED: 'PDF verificado',
  CONSENT_VIEWED: 'Consentimiento visto',
  CONSENT_DECLINED: 'Consentimiento rechazado',
  CONSENT_REVOKED: 'Consentimiento revocado',
};

const ACCESS_LABELS: Record<string, string> = {
  PATIENT_SEARCHED: 'Búsqueda',
  PDF_VIEWED: 'Vio el PDF',
  PDF_DOWNLOADED: 'Descargó el PDF',
};

function AccessList({ items }: { items: AccessItem[] }) {
  if (items.length === 0) return <p className="empty">Sin accesos registrados.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Acción</th>
            <th>Usuario</th>
            <th>IP</th>
            <th>Consentimiento</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={`${a.timestamp_utc}-${a.request_id}`}>
              <td>{formatDate(a.timestamp_utc)}</td>
              <td>
                {ACCESS_LABELS[a.event_type] ?? humanize(a.event_type)}
                {a.event_type === 'PATIENT_SEARCHED' && a.kind === 'access' ? ' (accesos)' : ''}
              </td>
              <td>{a.operator_username ?? a.operator_id ?? '—'}</td>
              <td className="mono">{a.ip_address ?? '—'}</td>
              <td className="mono">{a.consent_id ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
