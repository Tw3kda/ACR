import { useEffect, useRef, useState } from 'react';

import { getPdfUrl, type ConsentItem } from './api';
import { formatDate, humanize } from './format';

/**
 * Vista previa del PDF en la misma pantalla. La URL firmada (inline, 60 s) se
 * pide al abrir y el visor del navegador la carga en un iframe: los bytes van
 * de S3 al navegador sin pasar por el API.
 */
export default function PdfModal({ consent, onClose }: { consent: ConsentItem; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    getPdfUrl(consent.consent_id, true)
      .then((r) => alive && setUrl(r.url))
      .catch((err) => alive && setError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [consent.consent_id]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const download = async () => {
    setDownloading(true);
    try {
      window.location.assign((await getPdfUrl(consent.consent_id, false)).url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  // En móviles el visor embebido a veces no existe: se ofrece abrirlo aparte.
  const openInTab = async () => {
    const win = window.open('', '_blank');
    try {
      const { url: fresh } = await getPdfUrl(consent.consent_id, true);
      if (win) win.location.href = fresh;
    } catch (err) {
      win?.close();
      setError((err as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`PDF ${consent.consent_id}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-title">
            <strong>{humanize(consent.log.subject?.medical_exam_type) || consent.consent_id}</strong>
            <span className="muted small">
              {consent.log.subject?.full_name} · {formatDate(consent.timestamp_utc)}
            </span>
          </div>
          <div className="actions">
            <button className="btn btn-ghost" onClick={download} disabled={downloading}>
              {downloading ? 'Preparando…' : 'Descargar'}
            </button>
            <button className="btn btn-link" onClick={openInTab}>
              Abrir en pestaña
            </button>
            <button ref={closeRef} className="btn btn-primary" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </header>

        <div className="modal-body">
          {error ? (
            <p className="error banner" role="alert">{error}</p>
          ) : url ? (
            <iframe title={`PDF ${consent.consent_id}`} src={url} />
          ) : (
            <p className="muted center">Cargando PDF…</p>
          )}
        </div>
      </div>
    </div>
  );
}
