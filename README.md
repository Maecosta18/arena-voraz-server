# Arena Voraz — servidor

Este es el juego completo: un servidor de Node.js (sin dependencias externas —
no necesita `npm install` de nada raro) más la página del juego en `public/`.

Con esto arriba, cualquiera entra al link y juega — **no necesita cuenta de
nada**. El multijugador (verse mover, dispararse, sumar kills) corre en vivo
a través de este servidor.

## Probarlo en tu computadora primero (opcional)

Si tenés Node.js instalado:

```
node server.js
```

Y abrís `http://localhost:3000` en el navegador. Para probar el multijugador,
abrí dos pestañas o compartí tu IP local con alguien en la misma red.

## Subirlo gratis a internet (recomendado: Render)

1. Creá una cuenta gratis en [render.com](https://render.com) (podés entrar
   con GitHub directamente).
2. Si todavía no tenés estos archivos en GitHub: entrá a
   [github.com](https://github.com), creá un repositorio nuevo (puede ser
   privado), y subí esta carpeta entera arrastrándola en "Add file → Upload
   files" desde la web de GitHub — no hace falta usar la terminal.
3. En Render, apretá **New +** → **Web Service**, conectá ese repositorio.
4. Configuración:
   - **Runtime**: Node
   - **Build Command**: `npm install` (no hay dependencias, así que esto es
     casi instantáneo)
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
5. Creá el servicio y esperá el deploy (unos minutos). Render te da una URL
   tipo `https://arena-voraz-xxxx.onrender.com` — ese es el link para
   compartir con tus amigos.

**Ojo con el plan gratis de Render**: si nadie entra durante ~15 minutos, el
servidor se "duerme" y la primera persona que abra el link después de eso
tiene que esperar unos 30-60 segundos a que arranque de nuevo. Después de esa
primera carga, todo funciona normal y fluido. Si esto te molesta, Railway
(railway.app) tiene un plan gratis con menos de esto, o cualquier plan pago
de cualquiera de los dos elimina el problema del todo.

## Alternativa: Railway

Los pasos son casi iguales: subís el repo a GitHub, entrás a
[railway.app](https://railway.app), "New Project" → "Deploy from GitHub
repo", y Railway detecta solo que es Node y usa `node server.js` como start
command (gracias al `package.json`).

## Qué guarda y qué no

El marcador general ("Récord del servidor") vive en la memoria del proceso —
se resetea si el servidor se reinicia o se re-despliega. Es así a propósito
para no complicar el setup con una base de datos aparte; si en algún momento
querés que el marcador sea permanente de verdad, avisale a Claude y se le
suma un archivo o una base de datos chiquita.

## Si algo no anda

- Si la página carga pero nadie se ve moverse: revisá que el **Start
  Command** sea exactamente `node server.js` (no `npm start` con un
  `package.json` roto, aunque este ya viene con el script `start` armado).
- Si Render/Railway marca error de build: probablemente no encontró
  `package.json` en la raíz — asegurate de haber subido el CONTENIDO de esta
  carpeta (no la carpeta en sí, es decir `server.js` y `package.json` deben
  quedar en la raíz del repositorio).
