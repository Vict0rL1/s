# TODO — estado tras completar las cinco fases

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
      mostrarse un 404 cuando en realidad falló la red.
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

### Producto
- [ ] **Las alertas no notifican**: se evalúan cuando abres la pestaña. Es una
      app local sin proceso en marcha. Un cron + notificación de escritorio
      sería el siguiente paso.
- [ ] **Una sola watchlist** ("Principal"). El esquema soporta varias.
- [ ] **Sin divisas.** Una posición en CAD y otra en USD se suman como si
      fueran la misma moneda. Si mezclas mercados, esto es lo primero que hay
      que arreglar.
- [ ] **Sin historial de precios de la cartera**: el P&L es puntual, no hay
      curva de valor en el tiempo.

## Mejoras pendientes

- [ ] Limpieza periódica de `api_cache` expirado y `api_call_log` viejo (hoy
      solo crecen; para uso personal tardará en importar).
- [ ] Alembic cuando el esquema empiece a migrar con datos valiosos dentro.
- [ ] WebSocket de Finnhub para cotizaciones en vivo sin gastar llamadas REST
      (lo incluye el tier gratuito).
- [ ] Paneles RSI/MACD como subgráficos bajo el precio (los datos ya viajan en
      el API, solo falta dibujarlos).
- [ ] Editar tesis existentes (hoy se crean y se borran).
- [ ] Exportar el portafolio y las tesis a CSV/Markdown.
- [ ] Detección de eventos en noticias (resultados, guidance, ratings) —
      quedó fuera de la Fase 3 por coste de API.
- [ ] `make dev` o docker-compose para levantar backend y frontend juntos.
