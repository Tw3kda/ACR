# Logos

## Cómo cambiar el logo

1. Deja **un solo archivo `.svg`** en esta carpeta (reemplaza el que está).
2. Ejecuta:

```bash
npm run logo:build
```

Eso regenera `acrLogo.ts`, que es el archivo que la app realmente importa.

## Por qué hay un paso de compilación

Metro no puede importar un `.svg` como texto, y leerlo en tiempo de ejecución
pasaría por el sandbox de archivos de Expo Go — el mismo que ya causó problemas
al compartir el PDF. Por eso el SVG se compila a un módulo TypeScript.

El SVG se inserta **en línea** dentro del HTML del documento que se convierte en
PDF (`features/consent/services/documentHtml.ts`, función `headerToHtml`). Al ser
vectorial no necesita base64, no puede fallar al cargar, y se ve nítido en
impresión.

## Dónde aparece

Únicamente en el encabezado del documento renderizado: la vista previa y el PDF
descargado. La pantalla de diligenciamiento no muestra encabezado.

- `acrLogo.ts` — **generado**, no lo edites a mano.
- `index.ts` — reexporta `ACR_LOGO_SVG`.
- `scripts/build-logo.mjs` — el generador.
