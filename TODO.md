# TODO — estado tras completar las cinco fases

> **Release Candidate 1**: la clasificación P0-P3 de estos puntos, y de los
> fallos que la auditoría encontró fuera de esta lista, está en
> `docs/RELEASE_CANDIDATE_AUDIT.md`. Lo que falta para el RC1 y lo que solo se
> puede verificar a mano está en `docs/RC1_CHECKLIST.md`.

## ⚠️ Lo primero: verificar con datos reales

Nada de esto se ha podido probar contra las APIs reales (el entorno donde se
programó bloquea la salida a internet financiero). Antes de confiar en un
número:

- [ ] Correr con tus keys y **contrastar 2-3 tickers contra tu broker**:
      precio, P/E, márgenes, deuda neta.
- [ ] Verificar que los estados financieros de EDGAR cuadran con el último
      10-K de una empresa que conozcas bien. El parser XBRL elige la primera
      etiqueta con datos anuales; empresas con contabilidad atípica pueden
      mapear mal alguna partida.
- [ ] Comprobar el DCF a mano una vez (los tests lo verifican, pero conviene
      que veas el número salir en pantalla y te cuadre).

## Limitaciones conocidas

### Datos
- [ ] **Sin intradía (1D/5D).** Los rangos van de 1M a 10A con barras diarias
      o semanales. Añadirlo cuesta créditos de Twelve Data.
- [ ] **EDGAR solo cubre empresas registradas en la SEC.** Una acción europea
      o canadiense sin ADR no tendrá estados financieros ni filings.
- [ ] **Composición de ETFs limitada a ~10 holdings** (única fuente gratuita).
      El solapamiento calculado es una cota inferior; la UI lo advierte pero
      conviene tenerlo presente al decidir.
- [ ] **yfinance no distingue "símbolo inexistente" de "red caída"**: puede
      mostrarse un 404 cuando en realidad falló la red. *Mitigado en el RC1*:
      el router ya no corta la cadena cuando UNA fuente dice «no existe» —
      solo si lo dicen todas—, y si una lo dice y otra está caída se trata como
      fallo, no como inexistencia. Queda abierto cuando yfinance es la única
      fuente que queda.
- [ ] **Sin datos de propiedad institucional (13F).** EDGAR los publica pero
      requiere parsear otro formato; hoy solo se listan los Forms 3/4/5 con
      enlace, sin desglose de importes por transacción.

### Análisis
- [ ] **Altman Z no aplica a bancos ni financieras.** Se avisa en la UI, pero
      la app no lo bloquea: no interpretes el número en esos casos.
- [ ] **ROIC usa una tasa impositiva fija del 21 %** (visible en la UI). Para
      empresas con tasa efectiva muy distinta, el ROIC quedará sesgado.
- [ ] **La beta se calcula siempre contra SPY.** Para una acción canadiense o
      europea, ese benchmark no es el adecuado.
- [ ] **SMA/RSI en rangos 5A/10A se calculan sobre barras semanales**, como
      en las plataformas de charting. Documentado, pero revisa si prefieres
      SMA diarias siempre.
- [ ] **El registro de aciertos solo evalúa dirección y magnitud del error.**
      Con pocas observaciones el azar domina — el propio resumen lo dice, pero
      no calcula significancia estadística.

### Motor de señales
- [ ] **El backtest tendrá pocas observaciones.** Con fundamentales anuales de
      EDGAR, 8 empresas y 6 años salen ~150 observaciones repartidas en 5
      rangos. Es probable que ningún rango llegue a las 30 necesarias y el
      modelo siga sin calibrar. **Esto es correcto, no un fallo**: significa
      que no hay evidencia suficiente para publicar probabilidades. Para
      calibrarlo de verdad hacen falta 30-50 empresas y 10+ años.
- [ ] **Universo pequeño = z-scores inestables.** Con 8 empresas, añadir o
      quitar una cambia todas las puntuaciones. Es una comparación relativa,
      no una medida absoluta.
- [ ] **Sin ajuste por sector.** Comparar el P/E de un banco con el de una
      tecnológica penaliza injustamente a la segunda. Lo correcto es puntuar
      dentro de cada sector; requiere universos más grandes.
- [ ] **El factor de sentimiento no está validado.** Entra en la señal en vivo
      (10 % del peso) pero se excluye del backtest por falta de histórico, así
      que su tasa de acierto es desconocida.
- [x] ~~**Sin costes de transacción ni deslizamiento** en el backtest.~~
      Hecho desde `8301e07` (comisión, horquilla, deslizamiento y divisa,
      desagregados) y el TODO no se había actualizado. En el RC1 se añade el
      coste TOTAL pagado a la comparación con los baselines.
- [ ] **Sesgo de supervivencia**: el universo lo eliges tú hoy, con empresas
      que existen hoy. Un backtest riguroso incluiría las que quebraron.

### Informe de analista
- [ ] **Los múltiplos históricos usan EPS y patrimonio ANUALES**, no TTM
      trimestral: la serie de P/E es escalonada (salta al publicarse cada
      10-K) en vez de suave. Suficiente para situar el percentil, no para
      comparar con un terminal profesional.
- [ ] **Sin desglose por segmento ni concentración de clientes**: EDGAR no lo
      expone estructurado en companyfacts. Para eso hay que leer el 10-K.
- [ ] **Riesgos solo cuantitativos.** Los umbrales detectan apalancamiento,
      cobertura, compresión de márgenes y valoración exigente. Competencia,
      regulación, calidad de la gestión o riesgo de disrupción no salen de las
      cifras — la UI lo dice, pero no lo suple.
- [ ] **Catalizadores limitados a lo que hay en los datos**: próximos
      resultados, filings recientes y eventos de noticias clasificados. No
      cubre vencimientos de patentes, litigios en curso ni días del inversor.
- [ ] El DCF precargado acota el crecimiento al 15 % y usa WACC fijos por
      escenario (9/10/12 %). Es un punto de partida, no una valoración
      afinada: edítalo en la pestaña Valoración.

### Producto
- [x] ~~**Las alertas no notifican**: se evalúan cuando abres la pestaña.~~
      Hecho: la evaluación salió del handler a `app/analysis/alertas.py`, y
      `backend/scripts/revisar_alertas.py` la corre desde el cron (línea de
      ejemplo en el README y en el docstring del propio guion). Avisa al
      escritorio con `notify-send`/`osascript`/PowerShell y **siempre** imprime
      por salida estándar, que es donde el aviso sobrevive aunque el escritorio
      falle. Una alerta salta una vez y el sello se pone ANTES de notificar.
      La pestaña dice si alguien está vigilando de verdad y desde cuándo, en vez
      de afirmarlo o negarlo a ciegas.
      **Pendiente de verificar en una máquina con escritorio**: aquí no hay
      sesión gráfica, así que el globo de notificación no se ha visto aparecer.
      Probado sí está lo demás — que el fallo del notificador no tumba la
      pasada y que dice el motivo exacto.
- [x] ~~**Las fechas de `positions` y `watchlist_items` se sirven sin zona.**~~
      Hecho en el RC1 (`6eab884`).
- [ ] **Una sola watchlist** ("Principal"). El esquema soporta varias.
- [x] ~~**Sin divisas.**~~ Hecho. Todo se convierte a USD antes de sumar, con
      tipos de FRED (gratis, 24 h de caché, una serie por divisa presente). Lo
      que no se puede convertir queda FUERA del total y se nombra en pantalla.
      **Pendiente de verificar con datos reales**: la dirección de cada serie de
      FRED está escrita a mano con su título al lado y un test la comprueba,
      pero nadie la ha contrastado contra un tipo real. Mira una vez que
      1 USD ≈ 1,3-1,4 CAD y no ≈ 0,7.
- [x] ~~**Sin historial de precios de la cartera.**~~ Hecho:
      `GET /api/portfolio/historial` reconstruye el valor día a día desde la
      primera compra, con la línea de lo invertido al lado y las ventas
      marcadas. El rendimiento y la peor caída salen de un índice encadenado,
      inmune a compras y ventas — sobre el valor bruto, vender contaba como
      caída.

## Mejoras pendientes

- [x] ~~Limpieza periódica de `api_cache` y `api_call_log`.~~ Hecho en el RC1:
      al arrancar y en cada pasada del cron. No borra lo recién caducado, que
      es lo que sostiene el rescate de dato viejo.
- [x] ~~Alembic.~~ Hecho en el RC1: migraciones 0001-0006, la app migra sola
      al arrancar y no arranca si no puede. Ver `docs/RC1_CHECKLIST.md`.
- [ ] WebSocket de Finnhub para cotizaciones en vivo sin gastar llamadas REST
      (lo incluye el tier gratuito).
- [x] ~~Paneles RSI/MACD como subgráficos bajo el precio.~~ Hecho, en panes de
      lightweight-charts. El RSI con escala FIJA 0-100 y sus bandas 70/30; el
      MACD con el histograma en verde/rojo según el signo.
- [ ] Editar tesis existentes (hoy se crean y se borran).
- [ ] Exportar el portafolio y las tesis a CSV/Markdown.
- [ ] Detección de eventos en noticias (resultados, guidance, ratings) —
      quedó fuera de la Fase 3 por coste de API.
- [x] Arranque en una sola terminal (`./start.sh`).
