import { useEffect, useState } from 'react';

import { logout, session, type Session } from './api';
import LoginPage from './LoginPage';
import HomePage from './HomePage';

export default function App() {
  const [current, setCurrent] = useState<Session | null>(session.get);

  // La sesión se cierra sola cuando vence el token de Cognito. Además del
  // temporizador (que el navegador puede retrasar con la pestaña dormida), se
  // revisa al volver a la pestaña.
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(logout, Math.max(0, current.expiresAt - Date.now()));
    const recheck = () => {
      if (document.visibilityState === 'visible' && !session.get()) logout();
    };
    document.addEventListener('visibilitychange', recheck);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [current]);

  useEffect(() => {
    const unsubscribe = session.subscribe(setCurrent);
    return () => {
      unsubscribe();
    };
  }, []);

  if (!current) return <LoginPage />;

  return (
    <>
      <header className="topbar">
        <span className="brand">Consulta de consentimientos</span>
        <span className="who">
          {current.user?.name || current.user?.email}
          <button className="btn btn-logout" onClick={logout}>
            Cerrar sesión
          </button>
        </span>
      </header>
      <main className="container">
        <HomePage />
      </main>
    </>
  );
}
